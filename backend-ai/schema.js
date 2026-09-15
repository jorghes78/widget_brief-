// Costruzione dinamica dello schema di estrazione a partire dal "manifest"
// che il widget invia descrivendo i propri campi.
//
// Il widget è la fonte di verità: se un giorno viene aggiunto un campo
// all'HTML, l'estrazione lo considera automaticamente senza toccare questo
// servizio. È una scelta deliberata — nella storia del file un elenco di
// campi statico e duplicato ha già causato una dimenticanza (un campo nuovo
// non compariva nella sintesi copiata).

export const NON_INDICATO = 'non_indicato';

/** Manifest malformato: è un errore di chi chiama, non del servizio. */
export class ErroreManifest extends Error {
  constructor(messaggio) {
    super(messaggio);
    this.name = 'ErroreManifest';
  }
}

const MAX_CAMPI = 200;
const ID_VALIDO = /^[A-Za-z0-9_-]{1,64}$/;

function testo(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Normalizza e valida il manifest ricevuto dal client.
 * Scarta silenziosamente le voci malformate invece di rifiutare tutta la
 * richiesta: un campo inatteso nel widget non deve rompere l'estrazione.
 */
export function normalizzaManifest(grezzo) {
  if (!Array.isArray(grezzo)) {
    throw new ErroreManifest('Il manifest dei campi deve essere un array.');
  }
  const visti = new Set();
  const campi = [];

  for (const voce of grezzo.slice(0, MAX_CAMPI)) {
    if (!voce || typeof voce !== 'object') continue;
    const id = typeof voce.id === 'string' ? voce.id.trim() : '';
    if (!ID_VALIDO.test(id) || visti.has(id)) continue;

    const etichetta = testo(voce.etichetta, 160);
    if (!etichetta) continue;

    const opzioni = Array.isArray(voce.opzioni)
      ? voce.opzioni.map((o) => testo(o, 60)).filter(Boolean).slice(0, 20)
      : [];

    visti.add(id);
    campi.push({
      id,
      etichetta,
      tipo: ['text', 'date', 'textarea', 'select'].includes(voce.tipo) ? voce.tipo : 'text',
      suggerimento: testo(voce.suggerimento, 300),
      sezione: testo(voce.sezione, 80),
      gruppo: testo(voce.gruppo, 120),
      obbligatorio: voce.obbligatorio === true,
      opzioni
    });
  }

  if (campi.length === 0) {
    throw new ErroreManifest('Il manifest dei campi è vuoto o non contiene voci valide.');
  }
  return campi;
}

/** Descrizione di un singolo campo, letta dal modello per capire cosa cercare. */
function descrizioneCampo(campo) {
  const parti = [];
  if (campo.gruppo) parti.push(`[${campo.sezione} › ${campo.gruppo}]`);
  else if (campo.sezione) parti.push(`[${campo.sezione}]`);
  parti.push(campo.etichetta + '.');
  if (campo.obbligatorio) parti.push('Campo obbligatorio del modulo: cercalo con particolare attenzione.');
  if (campo.suggerimento) parti.push(`Cosa contiene di solito: ${campo.suggerimento}`);

  if (campo.tipo === 'date') {
    parti.push(
      'Restituisci una data completa nel formato YYYY-MM-DD. ' +
      'Se il documento indica solo il mese, solo l\'anno o un periodo vago, restituisci null.'
    );
  } else if (campo.opzioni.length) {
    parti.push(
      `Rispondi "${campo.opzioni.join('" oppure "')}" solo se il documento lo dice esplicitamente, ` +
      `altrimenti "${NON_INDICATO}".`
    );
  } else {
    parti.push('Testo libero in italiano, oppure null se il documento non ne parla.');
  }
  return parti.join(' ');
}

/** Schema JSON passato a output_config.format per vincolare la risposta. */
export function costruisciSchema(campi) {
  const proprieta = {};

  for (const campo of campi) {
    if (campo.opzioni.length) {
      proprieta[campo.id] = {
        type: 'string',
        enum: [...campo.opzioni, NON_INDICATO],
        description: descrizioneCampo(campo)
      };
    } else {
      // I campi facoltativi devono poter essere null. La forma unione
      // { type: ['string','null'] } NON è accettata dalle uscite strutturate:
      // va scritta con anyOf, altrimenti l'API risponde 400.
      // Sulle date si dichiara anche il formato, così il vincolo YYYY-MM-DD
      // è strutturale e non affidato alla sola istruzione testuale.
      const tipoStringa = campo.tipo === 'date'
        ? { type: 'string', format: 'date' }
        : { type: 'string' };
      proprieta[campo.id] = {
        anyOf: [tipoStringa, { type: 'null' }],
        description: descrizioneCampo(campo)
      };
    }
  }

  return {
    type: 'object',
    properties: {
      campi: {
        type: 'object',
        properties: proprieta,
        required: campi.map((c) => c.id),
        additionalProperties: false
      },
      dedotti: {
        type: 'array',
        items: { type: 'string', enum: campi.map((c) => c.id) },
        description:
          'Elenco degli id dei campi il cui valore NON è scritto nero su bianco nel documento ' +
          'ma è stato ricavato per deduzione. Servono a segnalare al commerciale cosa ricontrollare. ' +
          'Array vuoto se hai estratto tutto alla lettera.'
      },
      sintesi: {
        type: 'string',
        description:
          'Una o due frasi in italiano su che tipo di documento è e quanto risulta completo ' +
          'rispetto a un brief di commessa fieristica. Nessun elenco, nessun markdown.'
      }
    },
    required: ['campi', 'dedotti', 'sintesi'],
    additionalProperties: false
  };
}
