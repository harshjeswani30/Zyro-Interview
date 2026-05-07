from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
import riva.client
import io
import wave
import os
from dotenv import load_dotenv
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

app = FastAPI()

# Enable CORS for the frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# NVIDIA NVCF Configuration
API_KEY = os.getenv("NVIDIA_API_KEY", "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")
FUNCTION_ID = "877104f7-e885-42b9-8de8-f6e4c6303969"
RIVA_URI = "grpc.nvcf.nvidia.com:443"

auth = riva.client.Auth(
    uri=RIVA_URI,
    use_ssl=True,
    metadata_args=[
        ('authorization', f'Bearer {API_KEY}'),
        ('function-id', FUNCTION_ID)
    ]
)

tts_service = riva.client.SpeechSynthesisService(auth)

@app.get("/tts")
async def text_to_speech(text: str = Query(...), speed: float = 1.0):
    try:
        # Note: Riva's Magpie-Multilingual might not support speed directly in the same way
        # but we'll use the voice_name and language_code requested
        resp = tts_service.synthesize(
            text=text,
            voice_name='Magpie-Multilingual',
            language_code='hi-IN'
        )
        
        # Audio is returned as raw PCM bytes, we need to wrap it in a WAV container for the browser
        # Riva returns 22050Hz by default for this model based on our investigation
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wav_file:
            wav_file.setnchannels(1)  # Mono
            wav_file.setsampwidth(2)   # 16-bit
            wav_file.setframerate(22050)
            wav_file.writeframes(resp.audio)
        
        return Response(content=buffer.getvalue(), media_type="audio/wav")
    except Exception as e:
        print(f"TTS Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
