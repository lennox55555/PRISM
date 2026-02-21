"""
api routers module.
contains all route handlers for the application.
- websocket: real-time audio streaming and svg generation
- api: rest endpoints for non-streaming operations
"""

from app.routers import websocket, api

__all__ = ["websocket", "api"]
