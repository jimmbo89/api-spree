// services/sii/DTEGenerator.js
const xml2js = require('xml2js');

class DTEGenerator {
  constructor() {
    this.builder = new xml2js.Builder({
      renderOpts: { pretty: true, indent: '  ' },
      headless: false,
      xmldec: { version: '1.0', encoding: 'ISO-8859-1' }
    });
  }

  async generateDTE(documentData, caf) {
    try {
      this.validateDocumentData(documentData);

      const dteXML = {
        DTE: {
          $: {
            'xmlns': 'http://www.sii.cl/SiiDte',
            'version': '1.0'
          },
          Documento: {
            $: { ID: `T${documentData.document_type}F${documentData.folio}` },
            Encabezado: {
              IdDoc: {
                TipoDTE: documentData.document_type,
                Folio: documentData.folio,
                FchEmis: documentData.fecha_emision,
                IndNoRebaja: 1
              },
              Emisor: {
                RUTEmisor: documentData.rut_emisor,
                RznSoc: documentData.legal_name_emisor || documentData.rut_emisor,
                GiroEmis: documentData.giro_emisor || 'Actividad Económica',
                Acteco: documentData.acteco || 1,
                DirOrigen: documentData.direccion_emisor || '',
                CmnaOrigen: documentData.comuna_emisor || '',
                CiudadOrigen: documentData.ciudad_emisor || ''
              },
              Receptor: {
                RUTRecep: documentData.rut_receptor,
                RznSocRecep: documentData.razon_social_receptor,
                GiroRecep: documentData.giro_receptor || '',
                DirRecep: documentData.direccion_receptor || '',
                CmnaRecep: documentData.comuna_receptor || '',
                CiudadRecep: documentData.ciudad_receptor || ''
              },
              Totales: {
                MntNeto: documentData.monto_neto,
                TasaIVA: 19,
                IVA: documentData.monto_iva,
                MntTotal: documentData.monto_total
              }
            },
            Detalle: documentData.detalles.map((item, index) => ({
              $: { NroLinDet: index + 1 },
              NmbItem: item.nombre,
              QtyItem: item.cantidad,
              PrcItem: item.precio_unitario,
              MontoItem: item.monto_item
            })),
            TED: this.buildTED(documentData, caf),
            TmstFirma: new Date().toISOString().replace(/\.\d+Z$/, '')
          }
        }
      };

      const xmlDte = this.builder.buildObject(dteXML);

      return { 
        xmlDte, 
        ted: this.buildTED(documentData, caf) 
      };
    } catch (error) {
      throw new Error(`Error generando DTE: ${error.message}`);
    }
  }

  buildTED(documentData, caf) {
    const tedData = {
      DD: {
        RE: documentData.rut_emisor,
        TD: documentData.document_type,
        F: documentData.folio,
        FE: documentData.fecha_emision,
        RR: documentData.rut_receptor,
        RSR: documentData.razon_social_receptor.substring(0, 40),
        MNT: documentData.monto_total,
        IT1: documentData.detalles[0].nombre.substring(0, 40),
        CAF: this.parseCAFXml(caf.caf_xml),
        TSTED: new Date().toISOString().replace(/\.\d+Z$/, '')
      }
    };

    const builder = new xml2js.Builder({ 
      headless: true,
      renderOpts: { pretty: false }
    });
    
    return builder.buildObject(tedData);
  }

  parseCAFXml(cafXml) {
    const cafMatch = cafXml.match(/<CAF[^>]*>[\s\S]*?<\/CAF>/);
    if (cafMatch) {
      return cafMatch[0];
    }
    return '<CAF/>';
  }

  validateDocumentData(data) {
    const required = ['document_type', 'folio', 'rut_emisor', 'rut_receptor', 
                      'razon_social_receptor', 'monto_neto', 'monto_iva', 
                      'monto_total', 'fecha_emision', 'detalles'];
    
    for (const field of required) {
      if (!data[field]) {
        throw new Error(`Campo requerido '${field}' no proporcionado`);
      }
    }

    if (!Array.isArray(data.detalles) || data.detalles.length === 0) {
      throw new Error('Debe proporcionar al menos un detalle');
    }
  }
}

module.exports = new DTEGenerator();