// src/utils/marketplaceUtil.js

/**
 * Obtiene el site_id de MercadoLibre desde el country code o domain
 * @param {string} countryCode - Código ISO del país (CL, AR, MX, etc.)
 * @param {string} domain - Dominio del marketplace
 * @returns {string} site_id de MercadoLibre (MLC, MLA, MLM, etc.)
 */
function getMercadoLibreSiteId(countryCodeOrDomain, domainArg) {
  // Compatibilidad: llamadas existentes pasan solo `domain`
  let countryCode = countryCodeOrDomain;
  let domain = domainArg;

  if (
    !domainArg &&
    typeof countryCodeOrDomain === "string" &&
    countryCodeOrDomain.toLowerCase().includes("mercado")
  ) {
    domain = countryCodeOrDomain;
    countryCode = null;
  }

  // Prioridad 1: country code desde config
  const countryMap = {
    CL: "MLC", AR: "MLA", MX: "MLM", CO: "MCO", 
    PE: "MPE", BR: "MLB", UY: "MLU", VE: "MLV",
    PY: "MPY", BO: "MBO", EC: "MEC", CR: "MCR",
    PA: "MPA", DO: "MRD", GT: "MGT", HN: "MHN",
    NI: "MNI", SV: "MSV", CU: "MCU"
  };
  
  const normalizedCountryCode = String(countryCode || "").trim().toUpperCase();
  if (normalizedCountryCode && countryMap[normalizedCountryCode]) {
    return countryMap[normalizedCountryCode];
  }
  
  // Prioridad 2: domain
  const domainMap = {
    "mercadolibre.cl": "MLC",
    "mercadolibre.com.ar": "MLA",
    "mercadolibre.com.mx": "MLM",
    "mercadolibre.com.co": "MCO",
    "mercadolibre.com.pe": "MPE",
    "mercadolibre.com.br": "MLB",
    "mercadolibre.com.uy": "MLU",
    "mercadolibre.com.ve": "MLV",
    "mercadolibre.com.py": "MPY",
    "mercadolibre.com.bo": "MBO",
    "mercadolibre.com.ec": "MEC",
    "mercadolibre.co.cr": "MCR",
    "mercadolibre.com.pa": "MPA",
    "mercadolibre.com.do": "MRD",
    "mercadolibre.com.gt": "MGT",
    "mercadolibre.com.hn": "MHN",
    "mercadolibre.com.ni": "MNI",
    "mercadolibre.com.sv": "MSV",
    "mercadolibre.com.cu": "MCU"
  };
  
  if (!domain) return "MLC";
  
  const domainLower = domain.toLowerCase().trim();
  for (const [key, value] of Object.entries(domainMap)) {
    if (domainLower.includes(key)) return value;
  }
  
  return "MLC"; // Default fallback
}

module.exports = { getMercadoLibreSiteId };
