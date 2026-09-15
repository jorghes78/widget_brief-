// Servizio di precompilazione del Brief di commessa WES.
//
// Riceve il documento che il cliente ha già inviato (PDF, Word, immagine),
// lo passa a Claude insieme alla descrizione dei campi del widget e
// restituisce i valori riconosciuti. Non conserva nulla: il file vive in
// memoria per la durata della richiesta e poi sparisce.

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

import { normalizzaManifest, costruisciSchema, ErroreManifest, NON_INDICATO } from './schema.js';
import { preparaDocumento, ErroreFormato } from './documento.js';

// ── Configurazione ────────────────────────────────────────────────────────
const PORTA = process.env.PORT || 3000;
const MODELLO = process.env.MODELLO || 'claude-sonnet-5';
const EFFORT = process.env.EFFORT || 'medium';
const PENSIERO = process.env.PENSIERO || 'adattivo';
const CODICE_ACCESSO = (process.env.CODICE_ACCESSO || '').trim();
const MAX_MB = Number(process.env.MAX_MB || 18);
const LIMITE_ORARIO = Number(process.env.LIMITE_ORARIO || 40);

const ORIGINI_CONSENTITE = (process.env.ORIGINI_CONSENTITE ||
  'https://jorghes78.github.io,http://localhost:8080,http://127.0.0.1:8080')
  .split(',').map((o) => o.trim()).filter(Boolean);

// Il widget si apre anche con un doppio click dal disco: in quel caso il
// browser manda Origin: null. Si può disattivare con CONSENTI_ORIGINE_NULL=false.
const CONSENTI_ORIGINE_NULL = process.env.CONSENTI_ORIGINE_NULL !== 'false';

const client = new Anthropic();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sta dietro un proxy: serve per leggere l'IP reale

// ── CORS ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origine = req.headers.origin;
  const ammessa =
    (origine === 'null' && CONSENTI_ORIGINE_NULL) ||
    (origine && ORIGINI_CONSENTITE.includes(origine));

  if (ammessa) {
    res.set('Access-Control-Allow-Origin', origine);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Codice-Accesso');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(ammessa ? 204 : 403);
  next();
});

app.use(express.json({ limit: `${Math.ceil(MAX_MB * 1.4) + 2}mb` }));

// ── Limite di richieste per IP (finestra di un'ora) ───────────────────────
const contatori = new Map();

function oltreIlLimite(ip) {
  const ora = Date.now();
  const finestra = 60 * 60 * 1000;
  const voce = contatori.get(ip);

  if (!voce || ora - voce.da > finestra) {
    contatori.set(ip, { da: ora, n: 1 });
    return false;
  }
  voce.n += 1;
  return voce.n > LIMITE_ORARIO;
}

// La mappa non cresce all'infinito: ogni 10 minuti si buttano le voci scadute
setInterval(() => {
  const soglia = Date.now() - 60 * 60 * 1000;
  for (const [ip, voce] of contatori) if (voce.da < soglia) contatori.delete(ip);
}, 10 * 60 * 1000).unref();

// ── Istruzioni per il modello ─────────────────────────────────────────────
const ISTRUZIONI = `Sei l'assistente di estrazione dati di WES (Worldwide Exhibition System), azienda che progetta e realizza stand fieristici su misura.

Un commerciale WES ha ricevuto da un cliente un documento di brief per una commessa fieristica. Devi leggerlo e precompilare, dove possibile, i campi del modulo interno di raccolta brief. Quello che estrai verrà mostrato al commerciale dentro il modulo, pronto per essere corretto: sei un punto di partenza, non l'ultima parola.

Regole non negoziabili:

1. Estrai soltanto ciò che il documento dice. Non inventare, non completare con quello che sarebbe "plausibile" per una fiera, non usare conoscenze tue sul cliente, sul settore o sulla manifestazione.

2. Se un'informazione non c'è, lascia il campo vuoto — stringa vuota "" per i campi di testo, null per le date. Un campo vuoto è un risultato corretto e utile: dice al commerciale cosa deve ancora chiedere al cliente. Un campo inventato è un danno, perché da quel momento in poi nessuno lo verificherà più.

3. L'assenza non è un no. Nei campi con risposta Sì/No, rispondi "No" solo se il documento esclude esplicitamente quell'elemento; se semplicemente non ne parla, rispondi "${NON_INDICATO}".

4. Scrivi in italiano, in forma sintetica, riprendendo per quanto possibile le parole del cliente. Nessun markdown, nessun elenco puntato dentro i valori: sono campi di un modulo, non un documento.

5. Riporta importi, metrature e quantità come sono scritti nel documento — stessa valuta, stessa unità, stesse fasce — senza convertirli, arrotondarli o normalizzarli.

6. Se un'informazione è rilevante per la progettazione ma non trova posto in nessun campo specifico, mettila nel campo delle note libere, quando presente fra i campi. Non ripetere lì cose già finite altrove.

7. Se il documento si contraddice, riporta il dato più recente o più specifico e segnala la contraddizione nelle note libere.

8. In "dedotti" elenca gli id dei campi il cui valore hai ricavato ragionando invece di leggerlo alla lettera. Esempio: la metratura non è scritta ma si desume dalle misure dello stand indicate in una tabella.`;

// ── Chiamata al modello ───────────────────────────────────────────────────
async function estrai({ blocchi, campi }) {
  const schema = costruisciSchema(campi);

  const richiesta = {
    model: MODELLO,
    max_tokens: 16000,
    system: ISTRUZIONI,
    output_config: {
      effort: EFFORT,
      format: { type: 'json_schema', schema }
    },
    messages: [
      {
        role: 'user',
        content: [
          ...blocchi,
          {
            type: 'text',
            text:
              'Questo è il documento di brief ricevuto dal cliente. Compila i campi del modulo ' +
              'seguendo lo schema richiesto e le regole che ti sono state date.'
          }
        ]
      }
    ]
  };

  if (PENSIERO !== 'disattivo') richiesta.thinking = { type: 'adaptive' };

  const risposta = await client.messages.create(richiesta);

  const testo = risposta.content.find((b) => b.type === 'text');
  if (!testo) throw new Error('Il modello non ha restituito alcun contenuto testuale.');

  let dati;
  try {
    dati = JSON.parse(testo.text);
  } catch {
    throw new Error('La risposta del modello non è JSON valido.');
  }

  return { dati, uso: risposta.usage, modello: risposta.model };
}

// ── Rotte ─────────────────────────────────────────────────────────────────

// Usata anche dal widget per "svegliare" il servizio: sul piano gratuito di
// Render l'istanza va in sospensione dopo un po' di inattività e la prima
// richiesta successiva può metterci quasi un minuto.
app.get('/health', (_req, res) => {
  res.json({ stato: 'attivo', modello: MODELLO, codiceRichiesto: Boolean(CODICE_ACCESSO) });
});

app.post('/api/estrai', async (req, res) => {
  if (CODICE_ACCESSO && req.get('X-Codice-Accesso') !== CODICE_ACCESSO) {
    return res.status(401).json({ errore: 'Codice di accesso mancante o errato.', codice: 'accesso' });
  }
  if (oltreIlLimite(req.ip)) {
    return res.status(429).json({
      errore: `Hai superato il limite di ${LIMITE_ORARIO} analisi all'ora. Riprova più tardi.`
    });
  }

  const { nomeFile, base64, manifest } = req.body || {};
  if (typeof base64 !== 'string' || !base64) {
    return res.status(400).json({ errore: 'Nessun file ricevuto.' });
  }

  const byte = Math.floor(base64.length * 0.75);
  if (byte > MAX_MB * 1024 * 1024) {
    return res.status(413).json({
      errore: `Il file supera il limite di ${MAX_MB} MB (${(byte / 1024 / 1024).toFixed(1)} MB).`
    });
  }

  try {
    const campi = normalizzaManifest(manifest);
    const documento = await preparaDocumento({ nomeFile: String(nomeFile || ''), base64 });
    const { dati, uso, modello } = await estrai({ blocchi: documento.blocchi, campi });

    console.log(
      `[estrai] ${nomeFile} · ${documento.tipo} · ${campi.length} campi · ` +
      `in ${uso?.input_tokens} out ${uso?.output_tokens} · ${modello}`
    );

    res.json({
      campi: dati.campi,
      dedotti: Array.isArray(dati.dedotti) ? dati.dedotti : [],
      sintesi: typeof dati.sintesi === 'string' ? dati.sintesi : '',
      meta: { tipoDocumento: documento.tipo, modello, uso }
    });
  } catch (err) {
    if (err instanceof ErroreManifest) {
      return res.status(400).json({ errore: err.message });
    }
    if (err instanceof ErroreFormato) {
      return res.status(415).json({ errore: err.message });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({
        errore: 'Il servizio AI ha raggiunto il limite di richieste. Riprova fra qualche minuto.'
      });
    }
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      console.error('[estrai] credenziali:', err.message);
      return res.status(502).json({
        errore: 'Il servizio AI ha rifiutato le credenziali. Controlla la chiave API su Render.'
      });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return res.status(504).json({ errore: 'Il servizio AI non risponde. Riprova fra poco.' });
    }
    if (err instanceof Anthropic.APIError) {
      console.error('[estrai] API:', err.status, err.message);
      // Il messaggio dell'API viene riportato al chiamante: è uno strumento
      // interno e senza quel dettaglio ogni diagnosi richiede di andare a
      // leggere i log del servizio. Non contiene dati del cliente.
      return res.status(502).json({
        errore: `Il servizio AI ha restituito un errore (${err.status}).`,
        dettaglio: String(err.message || '').slice(0, 500)
      });
    }
    console.error('[estrai] imprevisto:', err);
    res.status(500).json({ errore: err.message || "Errore imprevisto durante l'analisi." });
  }
});

// Corpo JSON troppo grande o malformato: express lo segnala qui
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ errore: `Il file supera il limite di ${MAX_MB} MB.` });
  }
  if (err instanceof SyntaxError) {
    return res.status(400).json({ errore: 'Richiesta malformata.' });
  }
  console.error('[server]', err);
  res.status(500).json({ errore: 'Errore imprevisto.' });
});

app.listen(PORTA, () => {
  console.log(`Brief AI WES in ascolto sulla porta ${PORTA} · modello ${MODELLO} · effort ${EFFORT}`);
  if (!CODICE_ACCESSO) {
    console.warn('ATTENZIONE: CODICE_ACCESSO non impostato, endpoint aperto a chiunque conosca l\'URL.');
  }
});
