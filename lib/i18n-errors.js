/**
 * Server-side i18n error message translation module.
 * Maps error codes used in apiError() calls to localized messages.
 */

const ERROR_MESSAGES = {
  en: {
    AUTH_REQUIRED: 'Authentication required',
    UNAUTHORIZED: 'Unauthorized',
    FORBIDDEN: 'Access denied',
    NOT_FOUND: 'Resource not found',
    RATE_LIMITED: 'Too many requests',
    INVALID_BODY: 'Invalid request body',
    INVALID_INPUT: 'Invalid input',
    INVALID_ID: 'Invalid identifier',
    INVALID_URL: 'Invalid URL',
    INVALID_FILE: 'Invalid file',
    INVALID_BASE64: 'Invalid base64 data',
    FILE_TOO_LARGE: 'File too large',
    DOC_TOO_LARGE: 'Document too large',
    UNSUPPORTED_FORMAT: 'Unsupported format',
    VALIDATION_ERROR: 'Validation error',
    BACKEND_UNREACHABLE: 'Backend service unreachable',
    EMBEDDING_FAILED: 'Embedding request failed',
    EMBEDDINGS_UNAVAILABLE: 'Embeddings service unavailable',
    EXTRACT_FAILED: 'Content extraction failed',
    OCR_FAILED: 'OCR processing failed',
    INTEGRATION_UNAVAILABLE: 'Integration unavailable',
    MONITORING_DISABLED: 'Monitoring is disabled',
    CHECK_FAILED: 'Health check failed',
    INSTALL_FAILED: 'Installation failed',
    UNINSTALL_FAILED: 'Uninstallation failed',
    RUN_FAILED: 'Execution failed',
    INTERNAL_ERROR: 'Internal server error'
  },
  es: {
    AUTH_REQUIRED: 'Autenticaci\u00f3n requerida',
    UNAUTHORIZED: 'No autorizado',
    FORBIDDEN: 'Acceso denegado',
    NOT_FOUND: 'Recurso no encontrado',
    RATE_LIMITED: 'Demasiadas solicitudes',
    INVALID_BODY: 'Cuerpo de solicitud no v\u00e1lido',
    INVALID_INPUT: 'Entrada no v\u00e1lida',
    INVALID_ID: 'Identificador no v\u00e1lido',
    INVALID_URL: 'URL no v\u00e1lida',
    INVALID_FILE: 'Archivo no v\u00e1lido',
    INVALID_BASE64: 'Datos base64 no v\u00e1lidos',
    FILE_TOO_LARGE: 'Archivo demasiado grande',
    DOC_TOO_LARGE: 'Documento demasiado grande',
    UNSUPPORTED_FORMAT: 'Formato no soportado',
    VALIDATION_ERROR: 'Error de validaci\u00f3n',
    BACKEND_UNREACHABLE: 'Servicio backend inalcanzable',
    EMBEDDING_FAILED: 'Solicitud de embeddings fallida',
    EMBEDDINGS_UNAVAILABLE: 'Servicio de embeddings no disponible',
    EXTRACT_FAILED: 'Extracci\u00f3n de contenido fallida',
    OCR_FAILED: 'Procesamiento OCR fallido',
    INTEGRATION_UNAVAILABLE: 'Integraci\u00f3n no disponible',
    MONITORING_DISABLED: 'Monitoreo desactivado',
    CHECK_FAILED: 'Verificaci\u00f3n de salud fallida',
    INSTALL_FAILED: 'Instalaci\u00f3n fallida',
    UNINSTALL_FAILED: 'Desinstalaci\u00f3n fallida',
    RUN_FAILED: 'Ejecuci\u00f3n fallida',
    INTERNAL_ERROR: 'Error interno del servidor'
  },
  fr: {
    AUTH_REQUIRED: 'Authentification requise',
    UNAUTHORIZED: 'Non autoris\u00e9',
    FORBIDDEN: 'Acc\u00e8s refus\u00e9',
    NOT_FOUND: 'Ressource introuvable',
    RATE_LIMITED: 'Trop de requ\u00eates',
    INVALID_BODY: 'Corps de requ\u00eate invalide',
    INVALID_INPUT: 'Entr\u00e9e invalide',
    INVALID_ID: 'Identifiant invalide',
    INVALID_URL: 'URL invalide',
    INVALID_FILE: 'Fichier invalide',
    INVALID_BASE64: 'Donn\u00e9es base64 invalides',
    FILE_TOO_LARGE: 'Fichier trop volumineux',
    DOC_TOO_LARGE: 'Document trop volumineux',
    UNSUPPORTED_FORMAT: 'Format non pris en charge',
    VALIDATION_ERROR: 'Erreur de validation',
    BACKEND_UNREACHABLE: 'Service backend inaccessible',
    EMBEDDING_FAILED: '\u00c9chec de la requ\u00eate d\u2019embeddings',
    EMBEDDINGS_UNAVAILABLE: 'Service d\u2019embeddings indisponible',
    EXTRACT_FAILED: '\u00c9chec de l\u2019extraction du contenu',
    OCR_FAILED: '\u00c9chec du traitement OCR',
    INTEGRATION_UNAVAILABLE: 'Int\u00e9gration indisponible',
    MONITORING_DISABLED: 'Surveillance d\u00e9sactiv\u00e9e',
    CHECK_FAILED: '\u00c9chec du bilan de sant\u00e9',
    INSTALL_FAILED: '\u00c9chec de l\u2019installation',
    UNINSTALL_FAILED: '\u00c9chec de la d\u00e9sinstallation',
    RUN_FAILED: '\u00c9chec de l\u2019ex\u00e9cution',
    INTERNAL_ERROR: 'Erreur interne du serveur'
  },
  de: {
    AUTH_REQUIRED: 'Authentifizierung erforderlich',
    UNAUTHORIZED: 'Nicht autorisiert',
    FORBIDDEN: 'Zugriff verweigert',
    NOT_FOUND: 'Ressource nicht gefunden',
    RATE_LIMITED: 'Zu viele Anfragen',
    INVALID_BODY: 'Ung\u00fcltiger Anfragetext',
    INVALID_INPUT: 'Ung\u00fcltige Eingabe',
    INVALID_ID: 'Ung\u00fcltiger Bezeichner',
    INVALID_URL: 'Ung\u00fcltige URL',
    INVALID_FILE: 'Ung\u00fcltige Datei',
    INVALID_BASE64: 'Ung\u00fcltige Base64-Daten',
    FILE_TOO_LARGE: 'Datei zu gro\u00df',
    DOC_TOO_LARGE: 'Dokument zu gro\u00df',
    UNSUPPORTED_FORMAT: 'Nicht unterst\u00fctztes Format',
    VALIDATION_ERROR: 'Validierungsfehler',
    BACKEND_UNREACHABLE: 'Backend-Dienst nicht erreichbar',
    EMBEDDING_FAILED: 'Embedding-Anfrage fehlgeschlagen',
    EMBEDDINGS_UNAVAILABLE: 'Embedding-Dienst nicht verf\u00fcgbar',
    EXTRACT_FAILED: 'Inhaltsextraktion fehlgeschlagen',
    OCR_FAILED: 'OCR-Verarbeitung fehlgeschlagen',
    INTEGRATION_UNAVAILABLE: 'Integration nicht verf\u00fcgbar',
    MONITORING_DISABLED: '\u00dcberwachung deaktiviert',
    CHECK_FAILED: 'Gesundheitspr\u00fcfung fehlgeschlagen',
    INSTALL_FAILED: 'Installation fehlgeschlagen',
    UNINSTALL_FAILED: 'Deinstallation fehlgeschlagen',
    RUN_FAILED: 'Ausf\u00fchrung fehlgeschlagen',
    INTERNAL_ERROR: 'Interner Serverfehler'
  }
};

const SUPPORTED_LANGUAGES = Object.keys(ERROR_MESSAGES);

export function getErrorMessage(code, lang = 'en') {
  return ERROR_MESSAGES[lang]?.[code] || ERROR_MESSAGES.en[code] || code;
}

export function detectLanguage(req) {
  const header = req?.headers?.['accept-language'] || req?.get?.('Accept-Language') || '';
  if (!header) return 'en';

  // Parse Accept-Language header: en-US,en;q=0.9,fr;q=0.8
  const candidates = header
    .split(',')
    .map((entry) => {
      const [locale, qPart] = entry.trim().split(';');
      const q = qPart ? parseFloat(qPart.replace('q=', '')) : 1.0;
      return { locale: locale.trim().toLowerCase(), q };
    })
    .sort((a, b) => b.q - a.q);

  for (const { locale } of candidates) {
    // Exact match (e.g. "fr")
    if (SUPPORTED_LANGUAGES.includes(locale)) return locale;
    // Language prefix match (e.g. "fr-FR" -> "fr")
    const prefix = locale.split('-')[0];
    if (SUPPORTED_LANGUAGES.includes(prefix)) return prefix;
  }

  return 'en';
}

export function getSupportedLanguages() {
  return [...SUPPORTED_LANGUAGES];
}
