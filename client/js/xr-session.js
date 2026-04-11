/**
 * Phase 49.1: Shared WebXR helpers for the browser VR/AR client.
 *
 * This module is plain ES modules -- no bundler, no transpile step -- and is
 * loaded directly by client/xr.html. It wraps the browser's navigator.xr API
 * with small helpers for:
 *   - feature detection (checkXrSupport)
 *   - session creation (requestSession)
 *   - a WebGL context tagged xrCompatible (createWebGlContext)
 *   - a minimal renderer (XrRenderer) that draws textured quads (the "panels")
 *   - a controller input handler (XrInputHandler)
 *   - a chat streaming helper (connectChatStream) that speaks SSE to SiskelBot
 *
 * The renderer is deliberately tiny: a single shader program, a unit quad,
 * and a helper that uploads an HTMLCanvasElement as a texture. Advanced 3D
 * (physics, avatars, mesh import) is out of scope; the goal is a readable
 * panel floating in front of the viewer that can display chat history.
 */

const VERT_SRC = `
  attribute vec3 aPosition;
  attribute vec2 aUv;
  uniform mat4 uProjection;
  uniform mat4 uView;
  uniform mat4 uModel;
  varying vec2 vUv;
  void main() {
    vUv = aUv;
    gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
  }
`;

const FRAG_SRC = `
  precision mediump float;
  uniform sampler2D uTexture;
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    vec4 tex = texture2D(uTexture, vUv);
    gl_FragColor = vec4(tex.rgb, tex.a * uAlpha);
  }
`;

/**
 * Check which WebXR session modes are supported in the current browser.
 * Never throws; instead returns a record with booleans and an optional
 * reason string when navigator.xr is entirely missing.
 *
 * @returns {Promise<{vr: boolean, ar: boolean, inline: boolean, reason?: string}>}
 */
export async function checkXrSupport() {
  if (typeof navigator === "undefined" || !("xr" in navigator) || !navigator.xr) {
    return { vr: false, ar: false, inline: false, reason: "WebXR not available in this browser" };
  }
  const xr = navigator.xr;
  const checks = await Promise.all([
    xr.isSessionSupported("immersive-vr").catch(() => false),
    xr.isSessionSupported("immersive-ar").catch(() => false),
    xr.isSessionSupported("inline").catch(() => false),
  ]);
  return { vr: checks[0], ar: checks[1], inline: checks[2] };
}

/**
 * Request a new XRSession.
 * @param {"immersive-vr"|"immersive-ar"|"inline"} mode
 * @param {object} [options] Additional session init options merged over defaults.
 * @returns {Promise<XRSession>}
 */
export async function requestSession(mode, options = {}) {
  if (typeof navigator === "undefined" || !navigator.xr) {
    throw new Error("navigator.xr is not available");
  }
  const baseInit = {
    requiredFeatures: mode === "inline" ? [] : ["local-floor"],
    optionalFeatures: [],
  };
  if (mode === "immersive-ar") {
    baseInit.optionalFeatures.push("hit-test", "dom-overlay");
  }
  if (mode === "immersive-vr") {
    baseInit.optionalFeatures.push("hand-tracking", "layers");
  }
  const init = {
    ...baseInit,
    ...options,
    requiredFeatures: [
      ...new Set([...(baseInit.requiredFeatures || []), ...(options.requiredFeatures || [])]),
    ],
    optionalFeatures: [
      ...new Set([...(baseInit.optionalFeatures || []), ...(options.optionalFeatures || [])]),
    ],
  };
  return navigator.xr.requestSession(mode, init);
}

/**
 * Create a WebGL2 (falling back to WebGL1) context tagged as xrCompatible.
 * The returned context is immediately usable as the base layer for an XRSession.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {WebGLRenderingContext|WebGL2RenderingContext}
 */
export function createWebGlContext(canvas) {
  const attrs = {
    alpha: true,
    antialias: true,
    depth: true,
    xrCompatible: true,
    preserveDrawingBuffer: false,
  };
  const gl = canvas.getContext("webgl2", attrs) || canvas.getContext("webgl", attrs);
  if (!gl) throw new Error("WebGL is not available");
  return gl;
}

function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error("Shader compile failed: " + info);
  }
  return shader;
}

function linkProgram(gl, vs, fs) {
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error("Program link failed: " + info);
  }
  return prog;
}

function mat4Identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function mat4Scale(sx, sy, sz) {
  const m = mat4Identity();
  m[0] = sx;
  m[5] = sy;
  m[10] = sz;
  return m;
}

/**
 * Minimal WebGL renderer that can draw textured panels in 3D space. It owns
 * a shared shader program, a unit quad, and the session's base layer bindings.
 */
export class XrRenderer {
  constructor(gl) {
    this.gl = gl;
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    this.program = linkProgram(gl, vs, fs);
    this.attrs = {
      aPosition: gl.getAttribLocation(this.program, "aPosition"),
      aUv: gl.getAttribLocation(this.program, "aUv"),
    };
    this.uniforms = {
      uProjection: gl.getUniformLocation(this.program, "uProjection"),
      uView: gl.getUniformLocation(this.program, "uView"),
      uModel: gl.getUniformLocation(this.program, "uModel"),
      uTexture: gl.getUniformLocation(this.program, "uTexture"),
      uAlpha: gl.getUniformLocation(this.program, "uAlpha"),
    };

    // Unit quad (two triangles) in the XY plane, facing -Z.
    // prettier-ignore
    const verts = new Float32Array([
      -0.5, -0.5, 0,   0, 1,
       0.5, -0.5, 0,   1, 1,
       0.5,  0.5, 0,   1, 0,
      -0.5, -0.5, 0,   0, 1,
       0.5,  0.5, 0,   1, 0,
      -0.5,  0.5, 0,   0, 0,
    ]);
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    this._currentFrame = null;
    this._currentRefSpace = null;
  }

  beginFrame(frame, refSpace) {
    this._currentFrame = frame;
    this._currentRefSpace = refSpace;
    const gl = this.gl;
    const session = frame.session;
    const baseLayer = session.renderState.baseLayer;
    if (baseLayer) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
      gl.viewport(0, 0, baseLayer.framebufferWidth, baseLayer.framebufferHeight);
    }
    gl.clearColor(0.02, 0.03, 0.08, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * Draw a textured quad. `pose` is an XRRigidTransform (or null for identity).
   */
  drawPanel(pose, width, height, texture) {
    const gl = this.gl;
    const frame = this._currentFrame;
    const refSpace = this._currentRefSpace;
    if (!frame || !refSpace) return;
    const viewerPose = frame.getViewerPose(refSpace);
    if (!viewerPose) return;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.attrs.aPosition);
    gl.vertexAttribPointer(this.attrs.aPosition, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(this.attrs.aUv);
    gl.vertexAttribPointer(this.attrs.aUv, 2, gl.FLOAT, false, 20, 12);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.uniforms.uTexture, 0);
    gl.uniform1f(this.uniforms.uAlpha, 1.0);

    const model = mat4Scale(width, height, 1);
    // Apply pose translation if provided.
    if (pose && pose.position) {
      model[12] = pose.position.x;
      model[13] = pose.position.y;
      model[14] = pose.position.z;
    } else {
      model[14] = -1.5; // default 1.5m in front of the viewer
      model[13] = 1.6; // approximate eye height
    }
    gl.uniformMatrix4fv(this.uniforms.uModel, false, model);

    for (const view of viewerPose.views) {
      const vp = frame.session.renderState.baseLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      gl.uniformMatrix4fv(this.uniforms.uProjection, false, view.projectionMatrix);
      gl.uniformMatrix4fv(this.uniforms.uView, false, view.transform.inverse.matrix);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  /**
   * Render a text label. The caller supplies an HTMLCanvasElement; this helper
   * uploads it as a texture and draws it as a panel at `pose`.
   */
  drawText(pose, canvas, widthMeters = 1.0) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    const aspect = canvas.height / Math.max(1, canvas.width);
    this.drawPanel(pose, widthMeters, widthMeters * aspect, tex);
    // Not deleted immediately; GL will GC with the context. In a real app
    // we would cache textures keyed by content hash.
  }

  endFrame() {
    this._currentFrame = null;
    this._currentRefSpace = null;
  }
}

/**
 * Simple controller / pointer tracker. `pollControllers` returns an array of
 * rays (origin + direction) for any sources that support the "gaze" or
 * "tracked-pointer" target modes. The returned objects are plain data so they
 * can be safely logged or used for hit testing.
 */
export class XrInputHandler {
  constructor(session) {
    this.session = session;
    this.rays = [];
  }

  pollControllers(frame, refSpace) {
    const out = [];
    if (!this.session || !this.session.inputSources) return out;
    for (const source of this.session.inputSources) {
      if (!source.targetRaySpace) continue;
      const pose = frame.getPose(source.targetRaySpace, refSpace);
      if (!pose) continue;
      const t = pose.transform;
      out.push({
        handedness: source.handedness || "none",
        targetRayMode: source.targetRayMode || "gaze",
        origin: { x: t.position.x, y: t.position.y, z: t.position.z },
        orientation: {
          x: t.orientation.x,
          y: t.orientation.y,
          z: t.orientation.z,
          w: t.orientation.w,
        },
      });
    }
    this.rays = out;
    return out;
  }
}

/**
 * Stream a chat completion from SiskelBot via Server-Sent Events.
 *
 * @param {string} endpoint Fully-qualified URL, e.g. "/v1/chat/completions".
 * @param {Array<{role: string, content: string}>} messages
 * @param {(token: string) => void} onToken Called for every streamed delta.
 * @param {object} [options]
 * @returns {Promise<string>} The concatenated response text.
 */
export async function connectChatStream(endpoint, messages, onToken, options = {}) {
  const body = JSON.stringify({
    model: options.model || "auto",
    stream: true,
    messages,
  });
  const headers = { "content-type": "application/json", accept: "text/event-stream" };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  const res = await fetch(endpoint, { method: "POST", headers, body, signal: options.signal });
  if (!res.ok || !res.body) {
    throw new Error(`chat stream failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed?.choices?.[0]?.delta?.content || parsed?.choices?.[0]?.message?.content || "";
        if (delta) {
          full += delta;
          if (typeof onToken === "function") onToken(delta);
        }
      } catch (_) {
        // swallow malformed SSE frames; backend quirks happen.
      }
    }
  }
  return full;
}
