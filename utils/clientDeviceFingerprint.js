// Enhanced Device Fingerprinting for Frontend
// This file provides client-side device fingerprinting that's stable across network changes
// Include this in your frontend to generate clientFingerprint

class DeviceFingerprint {
  constructor() {
    this.fingerprint = null;
  }

  // Main method to generate device fingerprint
  async generate() {
    if (this.fingerprint) {
      return this.fingerprint;
    }

    const components = await this.collectFingerprints();
    const fingerprintString = Object.values(components).join('|');
    
    // Create hash from fingerprint string
    this.fingerprint = await this.createHash(fingerprintString);
    
    console.log('🔐 Client device fingerprint generated:', {
      components,
      fingerprint: this.fingerprint.substring(0, 8) + '...'
    });
    
    return this.fingerprint;
  }

  // Collect stable device characteristics
  async collectFingerprints() {
    const components = {};

    // Screen characteristics (stable)
    components.screen = `${screen.width}x${screen.height}x${screen.colorDepth}`;
    components.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    components.language = navigator.language;
    components.platform = navigator.platform;
    
    // Hardware concurrency (CPU cores)
    components.hardwareConcurrency = navigator.hardwareConcurrency || 'unknown';
    
    // Memory (if available)
    if ('deviceMemory' in navigator) {
      components.deviceMemory = navigator.deviceMemory;
    }
    
    // WebGL renderer info (GPU)
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) {
          components.webglRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
          components.webglVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        }
      }
    } catch (e) {
      console.warn('WebGL fingerprinting failed:', e);
    }

    // Canvas fingerprinting (unique to device/browser)
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillText('Device fingerprint test 🔐', 2, 2);
      components.canvas = canvas.toDataURL().slice(-50); // Last 50 chars
    } catch (e) {
      console.warn('Canvas fingerprinting failed:', e);
    }

    // Audio context fingerprinting
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const analyser = audioContext.createAnalyser();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      components.audioContext = audioContext.sampleRate + '_' + audioContext.destination.maxChannelCount;
      audioContext.close();
    } catch (e) {
      console.warn('Audio fingerprinting failed:', e);
    }

    // Local storage check (persistent)
    try {
      const testKey = '_fp_test';
      localStorage.setItem(testKey, '1');
      const hasLocalStorage = localStorage.getItem(testKey) === '1';
      localStorage.removeItem(testKey);
      components.localStorage = hasLocalStorage;
    } catch (e) {
      components.localStorage = false;
    }

    // Session storage check
    try {
      const testKey = '_fp_test';
      sessionStorage.setItem(testKey, '1');
      const hasSessionStorage = sessionStorage.getItem(testKey) === '1';
      sessionStorage.removeItem(testKey);
      components.sessionStorage = hasSessionStorage;
    } catch (e) {
      components.sessionStorage = false;
    }

    // IndexedDB check
    components.indexedDB = !!window.indexedDB;

    // Touch support
    components.touchSupport = 'ontouchstart' in window;

    return components;
  }

  // Create hash from string
  async createHash(str) {
    if (crypto.subtle) {
      // Use Web Crypto API if available
      const encoder = new TextEncoder();
      const data = encoder.encode(str);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
    } else {
      // Fallback: simple hash function
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      return Math.abs(hash).toString(16).padStart(8, '0');
    }
  }

  // Get stored fingerprint or generate new one
  async getFingerprint() {
    try {
      // Try to get from localStorage first (persistent across sessions)
      const stored = localStorage.getItem('_device_fp');
      if (stored && stored.length > 20) {
        console.log('🔐 Using stored device fingerprint');
        this.fingerprint = stored;
        return stored;
      }
    } catch (e) {
      console.warn('Cannot access localStorage for fingerprint storage');
    }

    // Generate new fingerprint
    const fp = await this.generate();
    
    try {
      // Store for future use
      localStorage.setItem('_device_fp', fp);
    } catch (e) {
      console.warn('Cannot store fingerprint in localStorage');
    }

    return fp;
  }

  // Reset stored fingerprint (useful for testing)
  reset() {
    this.fingerprint = null;
    try {
      localStorage.removeItem('_device_fp');
    } catch (e) {
      console.warn('Cannot remove fingerprint from localStorage');
    }
  }
}

// Usage example:
// const deviceFp = new DeviceFingerprint();
// const clientFingerprint = await deviceFp.getFingerprint();
// 
// // Include clientFingerprint in your login request:
// fetch('/api/auth/login', {
//   method: 'POST',
//   headers: { 'Content-Type': 'application/json' },
//   body: JSON.stringify({
//     email: 'user@example.com',
//     password: 'password123',
//     clientFingerprint: clientFingerprint
//   })
// });

// Export for use in modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DeviceFingerprint;
}

// Global window object for direct script inclusion
if (typeof window !== 'undefined') {
  window.DeviceFingerprint = DeviceFingerprint;
}