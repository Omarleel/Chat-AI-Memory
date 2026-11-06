// El token administrativo vive solo en sessionStorage: se borra al cerrar la pestaña.
const KEY = 'chat-ai-memory.admin-token';
export const tokenStore = {
  get() {
    try {return sessionStorage.getItem(KEY) ?? '';} catch {return '';}
  },
  set(token) {
    try {sessionStorage.setItem(KEY, token);} catch {}
  },
  clear() {
    try {sessionStorage.removeItem(KEY);} catch {}
  }
};

// Preferencias no sensibles (contacto, sesión de preview, modelo) por comodidad.
export const prefs = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`chat-ai-memory.${key}`);
      return value === null ? fallback : JSON.parse(value);
    } catch {return fallback;}
  },
  set(key, value) {
    try {localStorage.setItem(`chat-ai-memory.${key}`, JSON.stringify(value));} catch {}
  }
};
