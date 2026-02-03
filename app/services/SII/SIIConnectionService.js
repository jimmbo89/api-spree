// services/sii/SIIConnectionService.js
const axios = require('axios');
const xml2js = require('xml2js');

class SIIConnectionService {
  constructor() {
    this.urls = {
      production: {
        upload: 'https://palena.sii.cl/cgi_dte/UPL/DTEUpload',
        query: 'https://palena.sii.cl/cgi_dte/UPL/QueryStatus'
      },
      certification: {
        upload: 'https://maullin.sii.cl/cgi_dte/UPL/DTEUpload',
        query: 'https://maullin.sii.cl/cgi_dte/UPL/QueryStatus'
      }
    };
  }

  async sendDTE(environment, xmlDte, signature, rutEmisor) {
    const startTime = Date.now();
    const url = this.urls[environment].upload;
    const endpoint = url;

    try {
      const soapEnvelope = this.buildSoapEnvelope(xmlDte, signature, rutEmisor);

      const response = await axios.post(url, soapEnvelope, {
        headers: {
          'Content-Type': 'text/xml; charset=ISO-8859-1',
          'SOAPAction': ''
        },
        timeout: 30000
      });

      const duration = Date.now() - startTime;
      const parsedResponse = await this.parseSendResponse(response.data);

      return {
        status: parsedResponse.status,
        trackId: parsedResponse.trackId,
        message: parsedResponse.message,
        errorCode: parsedResponse.errorCode,
        rawResponse: response.data,
        duration: duration,
        endpoint: endpoint
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      
      return {
        status: 'ERROR',
        trackId: null,
        message: error.message,
        errorCode: error.response?.status || 'CONNECTION_ERROR',
        rawResponse: error.response?.data || error.message,
        duration: duration,
        endpoint: endpoint
      };
    }
  }

  async queryStatus(environment, trackId) {
    const url = this.urls[environment].query;
    const endpoint = url;

    try {
      const soapEnvelope = this.buildQueryEnvelope(trackId);

      const response = await axios.post(url, soapEnvelope, {
        headers: {
          'Content-Type': 'text/xml; charset=ISO-8859-1',
          'SOAPAction': ''
        },
        timeout: 15000
      });

      const parsedResponse = await this.parseQueryResponse(response.data);

      return {
        estado: parsedResponse.estado,
        glosa: parsedResponse.glosa,
        errorCode: parsedResponse.errorCode,
        errorMessage: parsedResponse.errorMessage,
        rawResponse: response.data,
        endpoint: endpoint
      };

    } catch (error) {
      return {
        estado: 'ERROR',
        glosa: error.message,
        errorCode: error.response?.status || 'CONNECTION_ERROR',
        errorMessage: error.message,
        rawResponse: error.response?.data || error.message,
        endpoint: endpoint
      };
    }
  }

  buildSoapEnvelope(xmlDte, signature, rutEmisor) {
    return `<?xml version="1.0" encoding="ISO-8859-1"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.sii.cl/SiiDte">
  <SOAP-ENV:Header/>
  <SOAP-ENV:Body>
    <ns1:DTEUpload>
      <ns1:XMLDTE><![CDATA[${xmlDte}]]></ns1:XMLDTE>
      <ns1:Firma>${signature}</ns1:Firma>
      <ns1:RutEmisor>${rutEmisor}</ns1:RutEmisor>
    </ns1:DTEUpload>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
  }

  buildQueryEnvelope(trackId) {
    return `<?xml version="1.0" encoding="ISO-8859-1"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://www.sii.cl/SiiDte">
  <SOAP-ENV:Header/>
  <SOAP-ENV:Body>
    <ns1:QueryStatus>
      <ns1:TrackId>${trackId}</ns1:TrackId>
    </ns1:QueryStatus>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
  }

  async parseSendResponse(responseXml) {
    return new Promise((resolve) => {
      xml2js.parseString(responseXml, { explicitArray: false }, (err, result) => {
        if (err) {
          resolve({
            status: 'ERROR',
            trackId: null,
            message: 'Error parseando respuesta: ' + err.message,
            errorCode: 'PARSE_ERROR'
          });
          return;
        }

        try {
          const body = result['SOAP-ENV:Envelope']['SOAP-ENV:Body'];
          const uploadResponse = body['ns1:DTEUploadResponse'];
          
          if (uploadResponse && uploadResponse['ns1:STATUS'] === 'OK') {
            resolve({
              status: 'OK',
              trackId: uploadResponse['ns1:TrackId'],
              message: 'Documento recibido por SII',
              errorCode: null
            });
          } else {
            resolve({
              status: 'RECHAZADO',
              trackId: null,
              message: uploadResponse['ns1:GLOSA'] || 'Documento rechazado',
              errorCode: uploadResponse['ns1:STATUS']
            });
          }
        } catch (error) {
          resolve({
            status: 'ERROR',
            trackId: null,
            message: 'Error parseando respuesta: ' + error.message,
            errorCode: 'PARSE_ERROR'
          });
        }
      });
    });
  }

  async parseQueryResponse(responseXml) {
    return new Promise((resolve) => {
      xml2js.parseString(responseXml, { explicitArray: false }, (err, result) => {
        if (err) {
          resolve({
            estado: 'ERROR',
            glosa: 'Error parseando respuesta: ' + err.message,
            errorCode: 'PARSE_ERROR',
            errorMessage: err.message
          });
          return;
        }

        try {
          const body = result['SOAP-ENV:Envelope']['SOAP-ENV:Body'];
          const queryResponse = body['ns1:QueryStatusResponse'];
          
          if (queryResponse) {
            resolve({
              estado: queryResponse['ns1:ESTADO'] || 'PENDIENTE',
              glosa: queryResponse['ns1:GLOSA'] || '',
              errorCode: null,
              errorMessage: null
            });
          } else {
            resolve({
              estado: 'ERROR',
              glosa: 'Respuesta no válida del SII',
              errorCode: 'INVALID_RESPONSE',
              errorMessage: 'Estructura XML no reconocida'
            });
          }
        } catch (error) {
          resolve({
            estado: 'ERROR',
            glosa: error.message,
            errorCode: 'PARSE_ERROR',
            errorMessage: error.message
          });
        }
      });
    });
  }
}

module.exports = new SIIConnectionService();