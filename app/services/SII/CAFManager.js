// services/sii/CAFManager.js
const xml2js = require('xml2js');

class CAFManager {
  async parseCAFXml(xmlString) {
    return new Promise((resolve, reject) => {
      xml2js.parseString(xmlString, { explicitArray: false }, (err, result) => {
        if (err) {
          reject(new Error('Error parseando XML del CAF: ' + err.message));
          return;
        }

        try {
          const caf = result.CAF;
          if (!caf || !caf.DA) {
            reject(new Error('Estructura XML del CAF no válida'));
            return;
          }

          const data = caf.DA;
          
          resolve({
            documentType: data.TD,
            rangoD: parseInt(data.RNG.D),
            rangoH: parseInt(data.RNG.H),
            fa: data.FA,
            fe: data.FE,
            privateKey: caf.FRMA ? caf.FRMA._ : null,
            rutEmisor: data.RE
          });
        } catch (error) {
          reject(new Error('Error extrayendo datos del CAF: ' + error.message));
        }
      });
    });
  }

  async validateCAF(cafData, companyId, options = {}) {
    const { SIICafRepository } = require("../../repositories");

    if (!cafData.documentType || !cafData.rangoD || !cafData.rangoH) {
      return {
        isValid: false,
        message: 'CAF con datos incompletos'
      };
    }

    if (cafData.rangoD >= cafData.rangoH) {
      return {
        isValid: false,
        message: 'Rango de folios inválido (inicio >= fin)'
      };
    }

    const today = new Date();
    const issueDate = new Date(cafData.fa);
    const expirationDate = new Date(cafData.fe);

    if (isNaN(issueDate.getTime()) || isNaN(expirationDate.getTime())) {
      return {
        isValid: false,
        message: 'Fechas del CAF no válidas'
      };
    }

    if (expirationDate < today) {
      return {
        isValid: false,
        message: 'CAF expirado'
      };
    }

    if (issueDate > today) {
      return {
        isValid: false,
        message: 'CAF con fecha de inicio futura'
      };
    }

    const existingCaf = await SIICafRepository.findActiveByCompanyAndType(
      companyId,
      cafData.documentType,
      options
    );

    if (existingCaf) {
      return {
        isValid: false,
        message: `Ya existe un CAF activo para el tipo ${cafData.documentType}. Desactiva el anterior primero.`
      };
    }

    return {
      isValid: true,
      message: 'CAF válido',
      foliosCount: cafData.rangoH - cafData.rangoD + 1
    };
  }

  async getNextAvailableCAF(companyId, documentType, options = {}) {
    const { SIICafRepository } = require("../../repositories");

    return await SIICafRepository.getNextAvailableCAF(
      companyId,
      documentType,
      options
    );
  }
}

module.exports = new CAFManager();