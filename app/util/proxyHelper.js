const { SocksProxyAgent } = require('socks-proxy-agent');
const logger = require('../../config/logger');


class ProxyHelper {
  constructor() {
    this.useProxy = process.env.USE_SOCKS_PROXY === 'true';
    this.proxyUrl = process.env.SOCKS_PROXY_URL || 'socks5://127.0.0.1:1080';
    this.agent = null;
    
    this.init();
  }

  init() {
    if (this.useProxy) {
      try {
        this.agent = new SocksProxyAgent(this.proxyUrl);
        logger.info(`[ProxyHelper] Proxy SOCKS5 habilitado: ${this.proxyUrl}`);
      } catch (error) {
        logger.error(`[ProxyHelper] Error creando agente proxy: ${error.message}`);
        this.useProxy = false;
      }
    } else {
      logger.info('[ProxyHelper] Proxy SOCKS5 deshabilitado');
    }
  }

  /**
   * Obtiene la configuración de axios con/sin proxy
   * @param {Object} customConfig - Configuración adicional para axios
   * @returns {Object} Configuración para axios
   */
  getAxiosConfig(customConfig = {}) {
    const baseConfig = {
      timeout: customConfig.timeout || 15000,
      ...customConfig
    };

    if (this.useProxy && this.agent) {
      return {
        ...baseConfig,
        httpAgent: this.agent,
        httpsAgent: this.agent
      };
    }

    return baseConfig;
  }

  /**
   * Método conveniente para hacer requests con proxy automático
   * @param {string} url - URL a llamar
   * @param {Object} options - Opciones de axios
   * @returns {Promise} Promise con la respuesta
   */
  async request(url, options = {}) {
    const axios = require('axios');
    const config = {
      url,
      ...this.getAxiosConfig(options)
    };
    
    return axios(config);
  }

  /**
   * GET request con proxy automático
   */
  async get(url, options = {}) {
    return this.request(url, { method: 'GET', ...options });
  }

  /**
   * POST request con proxy automático
   */
  async post(url, data, options = {}) {
    return this.request(url, { method: 'POST', data, ...options });
  }

  /**
   * PUT request con proxy automático
   */
  async put(url, data, options = {}) {
    return this.request(url, { method: 'PUT', data, ...options });
  }

  /**
   * DELETE request con proxy automático
   */
  async delete(url, options = {}) {
    return this.request(url, { method: 'DELETE', ...options });
  }

  /**
   * Verifica si el proxy está activo
   */
  isProxyEnabled() {
    return this.useProxy && this.agent !== null;
  }

  /**
   * Habilita/deshabilita proxy dinámicamente
   */
  setProxyEnabled(enabled) {
    this.useProxy = enabled;
    if (!enabled) {
      this.agent = null;
    } else if (!this.agent) {
      this.agent = new SocksProxyAgent(this.proxyUrl);
    }
    logger.info(`[ProxyHelper] Proxy ${enabled ? 'habilitado' : 'deshabilitado'}`);
  }
}

// Exportar instancia singleton
module.exports = new ProxyHelper();