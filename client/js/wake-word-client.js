/**
 * Client-side wake-word listener.
 *
 * Uses the Web Audio API for continuous, low-overhead listening. Only
 * after a wake word is detected does the caller activate full STT,
 * minimizing API calls and privacy exposure.
 *
 * Detection is feature-based (RMS energy + zero-crossing cadence). When
 * Web Speech API is available, the listener also feeds the streaming
 * transcript through a wake-word matcher to confirm hits.
 *
 * Exposed on window.SiskelWakeWord.
 */

(function () {
  var DEFAULT_WAKE_WORDS = ["hey siskelbot", "hi siskelbot", "okay siskelbot", "ok siskelbot", "siskelbot"];
  var DEFAULT_THRESHOLD = 0.65;
  var FRAME_SIZE = 2048;
  var COOLDOWN_MS = 1500;

  function normalize(s) {
    if (typeof s !== "string") return "";
    return s.toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function transcriptMatchesWakeWord(transcript, wakeWords) {
    var t = normalize(transcript);
    if (!t) return { matched: false, word: null, score: 0 };
    for (var i = 0; i < wakeWords.length; i++) {
      var w = normalize(wakeWords[i]);
      if (!w) continue;
      if (t === w || t.indexOf(w) === 0 || t.indexOf(" " + w) >= 0) {
        return { matched: true, word: wakeWords[i], score: 1.0 };
      }
    }
    // Token-overlap fallback.
    var bestScore = 0;
    var bestWord = null;
    var tokens = t.split(" ");
    var seen = {};
    for (var k = 0; k < tokens.length; k++) seen[tokens[k]] = true;
    for (var j = 0; j < wakeWords.length; j++) {
      var target = normalize(wakeWords[j]).split(" ");
      var overlap = 0;
      for (var n = 0; n < target.length; n++) if (seen[target[n]]) overlap++;
      var score = overlap / target.length;
      if (score > bestScore) {
        bestScore = score;
        bestWord = wakeWords[j];
      }
    }
    return { matched: bestScore >= 0.75, word: bestWord, score: bestScore };
  }

  function computeFrameFeatures(buffer) {
    var sum = 0;
    var zc = 0;
    var peak = 0;
    var prev = 0;
    for (var i = 0; i < buffer.length; i++) {
      var v = buffer[i];
      sum += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
      if (i > 0 && ((prev >= 0 && v < 0) || (prev < 0 && v >= 0))) zc++;
      prev = v;
    }
    return { rms: Math.sqrt(sum / buffer.length), zeroCrossings: zc, peak: peak };
  }

  function scoreFeatures(features, wakeWord) {
    if (!features) return 0;
    var syllables = Math.max(1, wakeWord.split(/\s+/).length * 2);
    var energyOk = features.rms > 0.01 && features.peak > 0.05;
    var cadenceOk = features.zeroCrossings >= syllables * 4 && features.zeroCrossings <= syllables * 200;
    var score = 0;
    if (energyOk) score += 0.5;
    if (cadenceOk) score += 0.5;
    return Math.min(1, score);
  }

  /**
   * Create a wake-word listener instance.
   *
   * @param {object} [options]
   * @param {string[]} [options.wakeWords]
   * @param {number} [options.threshold] - Detection threshold in [0,1]
   * @param {boolean} [options.useSpeechRecognition] - Cross-check via Web Speech API
   * @param {Function} [options.onStatus] - Status change callback
   * @returns {object} listener
   */
  function createWakeWordListener(options) {
    var opts = Object.assign({
      wakeWords: DEFAULT_WAKE_WORDS.slice(),
      threshold: DEFAULT_THRESHOLD,
      useSpeechRecognition: true,
    }, options || {});

    var audioContext = null;
    var mediaStream = null;
    var sourceNode = null;
    var analyser = null;
    var rafHandle = null;
    var recognition = null;
    var listening = false;
    var wakeCallbacks = [];
    var statusCallbacks = [];
    var lastDetection = 0;
    var stats = {
      detections: 0,
      analyses: 0,
      lastWord: null,
      lastScore: 0,
      startedAt: 0,
    };

    function notifyWake(detection) {
      stats.detections++;
      stats.lastWord = detection.word;
      stats.lastScore = detection.score;
      lastDetection = Date.now();
      for (var i = 0; i < wakeCallbacks.length; i++) {
        try { wakeCallbacks[i](detection); } catch (e) { /* swallow */ }
      }
    }

    function notifyStatus(status) {
      if (typeof opts.onStatus === "function") {
        try { opts.onStatus(status); } catch (e) { /* swallow */ }
      }
      for (var i = 0; i < statusCallbacks.length; i++) {
        try { statusCallbacks[i](status); } catch (e) { /* swallow */ }
      }
    }

    function pollAnalyser() {
      if (!listening || !analyser) return;
      var buffer = new Float32Array(FRAME_SIZE);
      if (typeof analyser.getFloatTimeDomainData === "function") {
        analyser.getFloatTimeDomainData(buffer);
      }
      var features = computeFrameFeatures(buffer);
      stats.analyses++;
      var bestScore = 0;
      var bestWord = null;
      for (var i = 0; i < opts.wakeWords.length; i++) {
        var s = scoreFeatures(features, opts.wakeWords[i]);
        if (s > bestScore) {
          bestScore = s;
          bestWord = opts.wakeWords[i];
        }
      }
      stats.lastScore = bestScore;
      if (bestScore >= opts.threshold && (Date.now() - lastDetection) > COOLDOWN_MS && !opts.useSpeechRecognition) {
        notifyWake({ word: bestWord, score: bestScore, source: "audio" });
      }
      rafHandle = requestAnimationFrame(pollAnalyser);
    }

    function startSpeechRecognition() {
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return false;
      try {
        recognition = new SR();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = navigator.language || "en-US";
        recognition.onresult = function (event) {
          var text = "";
          for (var i = event.resultIndex; i < event.results.length; i++) {
            text += event.results[i][0].transcript;
          }
          var match = transcriptMatchesWakeWord(text, opts.wakeWords);
          if (match.matched && (Date.now() - lastDetection) > COOLDOWN_MS) {
            notifyWake({ word: match.word, score: match.score, transcript: text, source: "speech" });
          }
        };
        recognition.onerror = function (e) {
          notifyStatus({ state: "error", error: e && e.error ? e.error : "unknown" });
        };
        recognition.onend = function () {
          if (listening) {
            try { recognition.start(); } catch (_) { /* ignore */ }
          }
        };
        recognition.start();
        return true;
      } catch (e) {
        recognition = null;
        return false;
      }
    }

    function stopSpeechRecognition() {
      if (recognition) {
        try { recognition.onend = null; recognition.stop(); } catch (_) { /* ignore */ }
        recognition = null;
      }
    }

    async function start() {
      if (listening) return { ok: true, alreadyListening: true };
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        notifyStatus({ state: "error", error: "getUserMedia not supported" });
        return { ok: false, error: "getUserMedia not supported" };
      }
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        var Ctor = window.AudioContext || window.webkitAudioContext;
        audioContext = new Ctor();
        sourceNode = audioContext.createMediaStreamSource(mediaStream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = FRAME_SIZE;
        sourceNode.connect(analyser);
        listening = true;
        stats.startedAt = Date.now();
        notifyStatus({ state: "listening" });
        rafHandle = requestAnimationFrame(pollAnalyser);
        if (opts.useSpeechRecognition) startSpeechRecognition();
        return { ok: true };
      } catch (err) {
        listening = false;
        notifyStatus({ state: "error", error: err && err.message ? err.message : String(err) });
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    }

    function stop() {
      if (!listening) return { ok: true, alreadyStopped: true };
      listening = false;
      if (rafHandle) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
      stopSpeechRecognition();
      if (sourceNode) { try { sourceNode.disconnect(); } catch (_) {} sourceNode = null; }
      if (analyser) { try { analyser.disconnect(); } catch (_) {} analyser = null; }
      if (audioContext) { try { audioContext.close(); } catch (_) {} audioContext = null; }
      if (mediaStream) {
        var tracks = mediaStream.getTracks();
        for (var i = 0; i < tracks.length; i++) {
          try { tracks[i].stop(); } catch (_) {}
        }
        mediaStream = null;
      }
      notifyStatus({ state: "stopped" });
      return { ok: true };
    }

    function onWakeWord(callback) {
      if (typeof callback === "function") wakeCallbacks.push(callback);
    }

    function onStatus(callback) {
      if (typeof callback === "function") statusCallbacks.push(callback);
    }

    function setWakeWords(words) {
      if (Array.isArray(words)) {
        opts.wakeWords = words.filter(function (w) { return typeof w === "string" && w.trim().length > 0; });
      }
    }

    function getWakeWords() {
      return opts.wakeWords.slice();
    }

    function setThreshold(t) {
      if (typeof t === "number" && t >= 0 && t <= 1) opts.threshold = t;
    }

    function getStatus() {
      return {
        listening: listening,
        wakeWords: opts.wakeWords.slice(),
        threshold: opts.threshold,
        useSpeechRecognition: !!recognition,
        stats: Object.assign({}, stats),
      };
    }

    function getStats() {
      return Object.assign({}, stats);
    }

    return {
      start: start,
      stop: stop,
      onWakeWord: onWakeWord,
      onStatus: onStatus,
      setWakeWords: setWakeWords,
      getWakeWords: getWakeWords,
      setThreshold: setThreshold,
      getStatus: getStatus,
      getStats: getStats,
    };
  }

  /**
   * Send a transcript to the server for parsing into a structured command.
   * Convenience helper for clients that already have STT output.
   */
  async function parseCommand(transcript) {
    var base = (window.SISKELBOT_API_BASE || "/api/v1");
    var res = await fetch(base + "/voice/commands/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: transcript }),
    });
    return res.json();
  }

  async function executeCommand(transcript, context) {
    var base = (window.SISKELBOT_API_BASE || "/api/v1");
    var res = await fetch(base + "/voice/commands/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: transcript, context: context || {} }),
    });
    return res.json();
  }

  async function fetchHelp() {
    var base = (window.SISKELBOT_API_BASE || "/api/v1");
    var res = await fetch(base + "/voice/commands/help");
    return res.json();
  }

  window.SiskelWakeWord = {
    createWakeWordListener: createWakeWordListener,
    parseCommand: parseCommand,
    executeCommand: executeCommand,
    fetchHelp: fetchHelp,
    DEFAULT_WAKE_WORDS: DEFAULT_WAKE_WORDS.slice(),
  };
})();
