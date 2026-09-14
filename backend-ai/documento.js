// Trasforma il file caricato dal commerciale nei blocchi di contenuto che
// l'API di Claude sa leggere.
//
// I PDF non vengono convertiti in testo: si passano così come sono, perché
// il modello legge anche la pagina come immagine e regge quindi i PDF
// scansionati e quelli con tabelle e impaginazioni complesse — casi
// frequentissimi nei brief che arrivano dai clienti.

import mammoth from 'mammoth';

const IMMAGINI = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
};

const TESTUALI = ['txt', 'md', 'markdown', 'csv'];

export class ErroreFormato extends Error {
  constructor(messaggio) {
    super(messaggio);
    this.name = 'ErroreFormato';
  }
}

function estensione(nomeFile) {
  const m = /\.([A-Za-z0-9]+)$/.exec(nomeFile || '');
  return m ? m[1].toLowerCase() : '';
}

/**
 * @returns {{ blocchi: Array, tipo: string, caratteriTesto: number }}
 */
export async function preparaDocumento({ nomeFile, base64 }) {
  const ext = estensione(nomeFile);

  if (ext === 'pdf') {
    return {
      tipo: 'pdf',
      caratteriTesto: 0,
      blocchi: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 }
        }
      ]
    };
  }

  if (ext === 'docx') {
    const buffer = Buffer.from(base64, 'base64');
    let testo;
    try {
      ({ value: testo } = await mammoth.extractRawText({ buffer }));
    } catch {
      throw new ErroreFormato(
        'Il file .docx non è leggibile (potrebbe essere danneggiato o protetto da password). ' +
        'Prova a riaprirlo in Word e salvarlo come PDF.'
      );
    }
    testo = (testo || '').trim();
    if (!testo) {
      throw new ErroreFormato(
        'Il documento Word non contiene testo estraibile: probabilmente il brief è dentro immagini ' +
        'o caselle di testo grafiche. Salvalo come PDF e ricaricalo — dai PDF riesco a leggere anche il testo nelle immagini.'
      );
    }
    return {
      tipo: 'docx',
      caratteriTesto: testo.length,
      blocchi: [{ type: 'text', text: `Contenuto del documento «${nomeFile}»:\n\n${testo}` }]
    };
  }

  if (IMMAGINI[ext]) {
    return {
      tipo: 'immagine',
      caratteriTesto: 0,
      blocchi: [
        {
          type: 'image',
          source: { type: 'base64', media_type: IMMAGINI[ext], data: base64 }
        }
      ]
    };
  }

  if (TESTUALI.includes(ext)) {
    const testo = Buffer.from(base64, 'base64').toString('utf8').trim();
    if (!testo) throw new ErroreFormato('Il file è vuoto.');
    return {
      tipo: 'testo',
      caratteriTesto: testo.length,
      blocchi: [{ type: 'text', text: `Contenuto del documento «${nomeFile}»:\n\n${testo}` }]
    };
  }

  if (ext === 'doc') {
    throw new ErroreFormato(
      'Il formato .doc (Word 97-2003) non è supportato. Apri il file in Word e salvalo come .docx o come PDF.'
    );
  }

  throw new ErroreFormato(
    `Formato «.${ext || '?'}» non supportato. Formati accettati: PDF, DOCX, TXT, MD, CSV e immagini (PNG, JPG, WEBP).`
  );
}
