// Reglas del contacto: número internacional sin '+' ni separadores (8-15 dígitos), igual que la API.
export const normalizePhone = value => String(value ?? '').replace(/\D/g, '');
export const isValidPhone = value => /^\d{8,15}$/.test(normalizePhone(value));
