# Precompilazione del brief da documento cliente

Servizio di supporto al widget *Brief di commessa (Fiere)*. Riceve il documento che il
cliente ha già inviato (PDF, Word, immagine), lo fa leggere a Claude e restituisce i valori
riconosciuti, che il widget scrive nei propri campi.

Non conserva niente: il file vive in memoria per la durata della richiesta e poi sparisce.
Non c'è database, non c'è disco, non ci sono log del contenuto (solo nome file, tipo e
numero di token consumati).

---

## Come è fatto

```
index.html su GitHub Pages
   └─ blocco AI  ──POST /api/estrai──▶  questo servizio su Render
                                            └──▶ api.anthropic.com
```

Il servizio non conosce i campi del brief: è il widget a descriverglieli a ogni chiamata
(il "manifest", letto dal DOM). Quindi **un campo aggiunto domani all'HTML entra
nell'estrazione da solo**, senza toccare né ridistribuire questo servizio.

| File | Ruolo |
|---|---|
| `server.js` | rotte HTTP, CORS, limiti, chiamata al modello, gestione errori |
| `schema.js` | dal manifest del widget allo schema JSON che vincola la risposta |
| `documento.js` | dal file caricato ai blocchi di contenuto che l'API sa leggere |

---

## Passo 1 — Chiave API Anthropic

Serve un account **separato** da Claude Code, con fatturazione propria.

1. Vai su <https://console.anthropic.com> e registrati (o accedi).
2. **Billing → Add credits.** Senza credito le chiamate falliscono con un errore 400.
   Bastano 5 $ per cominciare: coprono qualche centinaio di brief.
3. **API keys → Create key.** Chiamala per esempio `wes-brief`.
4. Copia la chiave (`sk-ant-...`) **subito**: non è più visualizzabile dopo.
   Non metterla in nessun file che finisce su GitHub — va solo nel pannello Render.

---

## Passo 2 — Pubblicare il servizio su Render

La cartella `backend-ai/` va messa nel repository `widget_brief-`, accanto a `index.html`.

Dal pannello Render:

1. **New → Web Service**, collega il repository `jorghes78/widget_brief-`.
2. Compila così:
   - **Root Directory**: `backend-ai`
   - **Runtime**: Node
   - **Build Command**: `npm ci`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (si può salire dopo)
   - **Health Check Path**: `/health`
3. In **Environment** aggiungi le variabili della tabella qui sotto — almeno
   `ANTHROPIC_API_KEY` e `CODICE_ACCESSO`.
4. **Create Web Service.** Al termine Render mostra l'URL pubblico, del tipo
   `https://wes-brief-ai.onrender.com`. Segnatelo: serve al passo 3.

> In alternativa c'è `render.yaml` nella radice del repository (Blueprint): crea il servizio
> già configurato, ma i due valori segreti vanno comunque inseriti a mano.

### Variabili d'ambiente

| Variabile | Obbligatoria | Valore consigliato | A cosa serve |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **sì** | `sk-ant-...` | la chiave del passo 1 |
| `CODICE_ACCESSO` | consigliata | una parola concordata col team | senza, chiunque trovi l'URL può consumare il tuo credito. I commerciali lo inseriscono una volta sola, poi resta nel browser |
| `ORIGINI_CONSENTITE` | no | `https://jorghes78.github.io` | da quali siti il widget può chiamare il servizio |
| `CONSENTI_ORIGINE_NULL` | no | `true` | permette di usare la funzione anche aprendo il file HTML da disco |
| `MODELLO` | no | `claude-sonnet-5` | vedi "Costi" |
| `EFFORT` | no | `medium` | quanto a fondo ragiona il modello: `low` è più rapido, `high` più accurato |
| `PENSIERO` | no | `adattivo` | `disattivo` toglie il ragionamento: più veloce, meno affidabile sui Sì/No |
| `MAX_MB` | no | `18` | dimensione massima del file caricato |
| `LIMITE_ORARIO` | no | `40` | analisi all'ora per indirizzo IP |

Per verificare che sia in piedi, apri `https://…onrender.com/health`: deve rispondere
`{"stato":"attivo", …}`.

---

## Passo 3 — Collegare il widget

Nel file del widget, dentro il blocco AI, c'è una riga sola da cambiare:

```js
const ENDPOINT_PREDEFINITO = 'https://wes-brief-ai.onrender.com';
```

Mettici l'URL che Render ti ha dato, salva e ripubblica `index.html`. Fatto.

Al primo utilizzo su ogni postazione il widget chiede il codice di accesso e poi se lo
ricorda.

---

## Costi

Il costo dipende da quanto è lungo il documento. Un brief tipico di 3-5 pagine:

| Modello | Per brief | 200 brief all'anno |
|---|---|---|
| `claude-haiku-4-5` | ~0,02 € | ~4 € |
| `claude-sonnet-5` *(predefinito)* | ~0,05 € | ~10 € |
| `claude-opus-5` | ~0,11 € | ~22 € |

A questi volumi il costo non è il criterio: si sceglie sulla qualità dell'estrazione.
Sonnet 5 è il compromesso ragionevole. Se dopo qualche brief reale ti accorgi che Haiku
basta, cambia `MODELLO` su Render — non serve toccare il codice né ripubblicare il widget.

---

## Piano gratuito: la prima chiamata è lenta

Su Render Free l'istanza si spegne dopo circa 15 minuti di inattività, e la richiesta
successiva la riaccende: può volerci fino a un minuto. Il widget lo gestisce in due modi —
"sveglia" il servizio appena scegli il file (così spesso è già pronto quando clicchi
*Analizza*), e dopo 15 secondi di attesa spiega a schermo che cosa sta succedendo.

Se diventa fastidioso, il piano Starter di Render (circa 7 $/mese) tiene il servizio sempre acceso.

---

## Provarlo in locale

```bash
cd backend-ai
npm install
ANTHROPIC_API_KEY=sk-ant-... CODICE_ACCESSO=prova npm start
```

Poi, dalla console del browser con il widget aperto:

```js
localStorage.setItem('wes-ai-endpoint', 'http://localhost:3000')
```

Per tornare al servizio pubblicato: `localStorage.removeItem('wes-ai-endpoint')`.

---

## Formati accettati

| Formato | Come viene letto |
|---|---|
| `.pdf` | passato direttamente al modello, che legge anche la pagina come immagine: funziona sui PDF scansionati e sulle impaginazioni complesse |
| `.docx` | testo estratto lato server |
| `.txt` `.md` `.csv` | testo |
| `.png` `.jpg` `.webp` | lette come immagine (foto di un brief cartaceo) |
| `.doc` `.rtf` `.odt` | **non supportati** — il servizio risponde spiegando di salvare in PDF o DOCX |

---

## Togliere la funzione

Nel widget, cancella tutto ciò che sta fra `INIZIO BLOCCO AI` e `FINE BLOCCO AI`: il file
torna esattamente com'era prima (verificato byte per byte). Poi, se vuoi, elimina il
servizio da Render e la chiave dalla console Anthropic.
