"""
Main FastAPI application entry point.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routers import websocket, api

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    description="Real-time voice to SVG visualization API",
    version="0.1.0",
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(websocket.router, prefix="/ws", tags=["WebSocket"])
app.include_router(api.router, prefix="/api", tags=["API"])


@app.get("/")
async def root():
    """Health check endpoint."""
    return {"status": "healthy", "app": settings.app_name}


@app.get("/health")
async def health_check():
    """Detailed health check endpoint."""
    return {
        "status": "healthy",
        "version": "0.1.0",
        "stt_provider": settings.stt_provider,
        "llm_model": settings.llm_model,
    }
