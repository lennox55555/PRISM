# voice to svg visualization

a real-time application that converts voice input to text and generates svg visualizations using an llm.

## project structure

```
BOARD/
├── backend/                    # fastapi backend
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py            # fastapi application entry point
│   │   ├── config.py          # application configuration
│   │   ├── models/
│   │   │   ├── __init__.py
│   │   │   └── schemas.py     # pydantic models for request/response
│   │   ├── routers/
│   │   │   ├── __init__.py
│   │   │   ├── api.py         # rest api endpoints
│   │   │   └── websocket.py   # websocket handlers for real-time audio
│   │   ├── services/
│   │   │   ├── __init__.py
│   │   │   ├── speech_to_text.py   # audio transcription service
│   │   │   ├── llm_processor.py    # llm integration for svg generation
│   │   │   └── svg_generator.py    # svg validation and processing
│   │   └── utils/
│   │       ├── __init__.py
│   │       └── audio_utils.py      # audio format conversion utilities
│   ├── requirements.txt
│   └── .env.example
├── frontend/                   # react typescript frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── AudioRecorder.tsx      # main recording button component
│   │   │   ├── TranscriptionDisplay.tsx  # real-time text display
│   │   │   └── SVGRenderer.tsx        # svg visualization display
│   │   ├── hooks/
│   │   │   ├── useAudioRecorder.ts    # microphone recording hook
│   │   │   └── useWebSocket.ts        # websocket connection hook
│   │   ├── services/
│   │   │   └── api.ts                 # rest api client
│   │   ├── types/
│   │   │   └── index.ts               # typescript type definitions
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
└── README.md
```

## architecture

### data flow

1. user clicks record button in frontend
2. browser captures microphone audio
3. audio chunks are base64 encoded and sent via websocket
4. backend accumulates audio and sends to speech-to-text service
5. transcription results are streamed back to frontend in real-time
6. when recording stops, accumulated text is sent to llm processor
7. llm generates svg code based on the description
8. svg is sanitized, processed, and sent back to frontend
9. frontend renders the svg visualization

### backend services

each service is modular and can be extended or replaced independently:

- **speech_to_text.py**: handles audio transcription with provider abstraction (openai whisper, google, deepgram)
- **llm_processor.py**: manages llm communication for svg generation with customizable prompts
- **svg_generator.py**: validates, sanitizes, and optimizes svg output

### frontend components

- **AudioRecorder**: main interaction point with record button and audio level visualization
- **TranscriptionDisplay**: shows real-time transcription as user speaks
- **SVGRenderer**: displays generated svg with loading and error states

## setup

### backend

```bash
cd backend

# create virtual environment
python -m venv venv
source venv/bin/activate  # on windows: venv\Scripts\activate

# install dependencies
pip install -r requirements.txt

# copy environment file and add your api keys
cp .env.example .env

# run the server
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### frontend

```bash
cd frontend

# install dependencies
npm install

# run development server
npm run dev
```

the frontend will be available at http://localhost:5173
the backend api will be available at http://localhost:8000

## configuration

### environment variables

copy `backend/.env.example` to `backend/.env` and configure:

| variable | description | default |
|----------|-------------|---------|
| OPENAI_API_KEY | openai api key for whisper and gpt | required |
| LLM_MODEL | llm model to use | gpt-4 |
| STT_PROVIDER | speech-to-text provider | openai_whisper |
| CORS_ORIGINS | allowed cors origins | localhost:5173,localhost:3000 |

## api endpoints

### rest api

- `POST /api/text-to-svg` - generate svg from text description
- `POST /api/transcribe` - transcribe uploaded audio file
- `POST /api/transcribe-and-generate` - combined transcription and svg generation
- `GET /api/placeholder-svg` - get loading placeholder svg
- `GET /health` - health check endpoint

### websocket

- `ws://localhost:8000/ws/audio` - real-time audio streaming endpoint
  - send: `{"type": "start_recording"}` to begin
  - send: `{"type": "audio_chunk", "data": "<base64>"}` for audio data
  - send: `{"type": "stop_recording"}` to end
  - receive: transcription updates and generated svg

## extending the project

### adding a new speech-to-text provider

1. create a new class in `speech_to_text.py` extending `BaseSpeechToText`
2. implement the required methods: `transcribe_chunk`, `transcribe_stream`, `transcribe_file`
3. add the provider to the factory in `SpeechToTextService._get_provider`

### customizing svg generation

1. modify `SVG_SYSTEM_PROMPT` in `llm_processor.py` to change llm behavior
2. add new processing methods in `svg_generator.py` for custom transformations
3. update the `process_svg` pipeline to include new processing steps

### styling the frontend

all components use inline styles for simplicity. your team can:
- replace inline styles with css modules
- add a ui component library (chakra, material-ui, etc.)
- implement a design system

## development notes

- the backend uses asyncio for non-blocking operations
- websocket connections maintain state per session
- audio is accumulated in 1-second chunks for optimal transcription
- svg code is sanitized to prevent xss attacks
- mock services are available for development without api keys

## license

mit
