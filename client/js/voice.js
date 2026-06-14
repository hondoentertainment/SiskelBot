/**
 * Client-side voice interface using Web Speech API.
 * Provides speech-to-text input and text-to-speech output.
 * Falls back to server-side processing when Web Speech API is unavailable.
 *
 * Exports: createVoiceInput, createVoiceOutput
 * Exposed on window.SiskelVoice
 */

const API_BASE = window.SISKELBOT_API_BASE || '/api/v1';

/**
 * Create a voice input controller using SpeechRecognition.
 * @param {object} [options]
 * @param {string} [options.language] - BCP-47 language code (default: browser locale)
 * @param {boolean} [options.continuous] - Keep listening after results (default: false)
 * @param {boolean} [options.interimResults] - Emit partial results (default: true)
 * @param {boolean} [options.serverFallback] - Use server transcription if Web API unavailable (default: true)
 * @returns {object} Voice input controller
 */
function createVoiceInput(options) {
  var opts = Object.assign({
    language: navigator.language || 'en-US',
    continuous: false,
    interimResults: true,
    serverFallback: true,
  }, options || {});

  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recognition = null;
  var isListening = false;
  var resultCallbacks = [];
  var errorCallbacks = [];
  var statusCallbacks = [];
  var mediaRecorder = null;
  var audioChunks = [];

  function notifyResult(data) {
    resultCallbacks.forEach(function(cb) { cb(data); });
  }

  function notifyError(err) {
    errorCallbacks.forEach(function(cb) { cb(err); });
  }

  function notifyStatus(status) {
    statusCallbacks.forEach(function(cb) { cb(status); });
  }

  function isSupported() {
    return Boolean(SpeechRecognition) || opts.serverFallback;
  }

  function startWebSpeech() {
    recognition = new SpeechRecognition();
    recognition.lang = opts.language;
    recognition.continuous = opts.continuous;
    recognition.interimResults = opts.interimResults;

    recognition.onresult = function(event) {
      var transcript = '';
      var isFinal = false;
      for (var i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          isFinal = true;
        }
      }
      notifyResult({
        text: transcript,
        isFinal: isFinal,
        confidence: event.results[event.results.length - 1]?.[0]?.confidence || 0,
      });
    };

    recognition.onerror = function(event) {
      notifyError({ code: event.error, message: 'Speech recognition error: ' + event.error });
      if (event.error !== 'no-speech') {
        isListening = false;
        notifyStatus('stopped');
      }
    };

    recognition.onend = function() {
      if (isListening && opts.continuous) {
        try { recognition.start(); } catch (_) { /* already started */ }
      } else {
        isListening = false;
        notifyStatus('stopped');
      }
    };

    recognition.start();
    isListening = true;
    notifyStatus('listening');
  }

  function startServerFallback() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      notifyError({ code: 'NO_MICROPHONE', message: 'Microphone access not available' });
      return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function(stream) {
        audioChunks = [];
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

        mediaRecorder.ondataavailable = function(event) {
          if (event.data.size > 0) {
            audioChunks.push(event.data);
          }
        };

        mediaRecorder.onstop = function() {
          stream.getTracks().forEach(function(track) { track.stop(); });
          var blob = new Blob(audioChunks, { type: 'audio/webm' });
          sendToServer(blob);
        };

        mediaRecorder.start();
        isListening = true;
        notifyStatus('recording');
      })
      .catch(function(err) {
        notifyError({ code: 'MICROPHONE_ERROR', message: err.message || 'Failed to access microphone' });
      });
  }

  function sendToServer(blob) {
    var formData = new FormData();
    formData.append('audio', blob, 'recording.webm');
    if (opts.language) {
      formData.append('language', opts.language);
    }

    notifyStatus('transcribing');

    fetch(API_BASE + '/voice/transcribe', {
      method: 'POST',
      body: formData,
    })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.error) {
          notifyError({ code: data.code || 'SERVER_ERROR', message: data.error });
        } else {
          notifyResult({
            text: data.text || '',
            isFinal: true,
            confidence: data.confidence || 1.0,
            language: data.language,
            duration: data.duration,
          });
        }
        notifyStatus('stopped');
      })
      .catch(function(err) {
        notifyError({ code: 'NETWORK_ERROR', message: err.message || 'Failed to reach server' });
        notifyStatus('stopped');
      });
  }

  return {
    start: function() {
      if (isListening) return;
      if (SpeechRecognition) {
        startWebSpeech();
      } else if (opts.serverFallback) {
        startServerFallback();
      } else {
        notifyError({ code: 'NOT_SUPPORTED', message: 'Speech recognition not supported in this browser' });
      }
    },

    stop: function() {
      isListening = false;
      if (recognition) {
        try { recognition.stop(); } catch (_) { /* noop */ }
        recognition = null;
      }
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        mediaRecorder = null;
      }
      notifyStatus('stopped');
    },

    onResult: function(callback) {
      if (typeof callback === 'function') resultCallbacks.push(callback);
    },

    onError: function(callback) {
      if (typeof callback === 'function') errorCallbacks.push(callback);
    },

    onStatus: function(callback) {
      if (typeof callback === 'function') statusCallbacks.push(callback);
    },

    isSupported: isSupported,

    isListening: function() {
      return isListening;
    },
  };
}

/**
 * Create a voice output controller using SpeechSynthesis or server TTS.
 * @param {object} [options]
 * @param {string} [options.voice] - Preferred voice name
 * @param {number} [options.rate] - Speech rate 0.1-10 (default: 1)
 * @param {number} [options.pitch] - Pitch 0-2 (default: 1)
 * @param {boolean} [options.useServer] - Force server-side TTS (default: false)
 * @returns {object} Voice output controller
 */
function createVoiceOutput(options) {
  var opts = Object.assign({
    voice: null,
    rate: 1,
    pitch: 1,
    useServer: false,
  }, options || {});

  var synth = window.speechSynthesis || null;
  var selectedVoice = null;
  var currentAudio = null;
  var isSpeaking = false;

  function isSupported() {
    return Boolean(synth) || opts.useServer;
  }

  function findVoice(name) {
    if (!synth) return null;
    var voices = synth.getVoices();
    if (!name) return voices[0] || null;
    var lower = name.toLowerCase();
    return voices.find(function(v) {
      return v.name.toLowerCase().includes(lower) || v.lang.toLowerCase().includes(lower);
    }) || voices[0] || null;
  }

  // Initialize voice selection when voices are loaded
  if (synth && synth.onvoiceschanged !== undefined) {
    synth.onvoiceschanged = function() {
      if (opts.voice) selectedVoice = findVoice(opts.voice);
    };
  }

  function speakLocal(text) {
    if (!synth) return;
    var utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = opts.rate;
    utterance.pitch = opts.pitch;
    if (selectedVoice) utterance.voice = selectedVoice;

    utterance.onstart = function() { isSpeaking = true; };
    utterance.onend = function() { isSpeaking = false; };
    utterance.onerror = function() { isSpeaking = false; };

    synth.speak(utterance);
  }

  function speakServer(text) {
    fetch(API_BASE + '/voice/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, voice: opts.voice }),
    })
      .then(function(res) {
        if (!res.ok) throw new Error('TTS request failed: HTTP ' + res.status);
        return res.blob();
      })
      .then(function(blob) {
        var url = URL.createObjectURL(blob);
        currentAudio = new Audio(url);
        currentAudio.onplay = function() { isSpeaking = true; };
        currentAudio.onended = function() {
          isSpeaking = false;
          URL.revokeObjectURL(url);
          currentAudio = null;
        };
        currentAudio.onerror = function() {
          isSpeaking = false;
          URL.revokeObjectURL(url);
          currentAudio = null;
        };
        currentAudio.play();
      })
      .catch(function() {
        isSpeaking = false;
      });
  }

  return {
    speak: function(text) {
      if (!text) return;
      this.stop();
      if (opts.useServer) {
        speakServer(text);
      } else if (synth) {
        speakLocal(text);
      } else {
        speakServer(text);
      }
    },

    stop: function() {
      isSpeaking = false;
      if (synth) {
        synth.cancel();
      }
      if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
      }
    },

    setVoice: function(voice) {
      opts.voice = voice;
      selectedVoice = findVoice(voice);
    },

    getVoices: function() {
      if (!synth) return [];
      return synth.getVoices().map(function(v) {
        return { name: v.name, lang: v.lang, default: v.default };
      });
    },

    isSupported: isSupported,

    isSpeaking: function() {
      return isSpeaking;
    },
  };
}

// Expose on window
window.SiskelVoice = {
  createVoiceInput: createVoiceInput,
  createVoiceOutput: createVoiceOutput,
};
