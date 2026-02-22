"""
LLM processor service module using LangChain.
Handles communication with large language models to generate SVG code,
summaries, and other text processing tasks.
Uses LangChain for unified interface, retry logic, and fallbacks.
"""

import logging
import re
import time
from typing import Any, Optional, Tuple

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate, PromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_core.runnables import RunnableWithFallbacks
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

from app.config import get_settings
from app.models.schemas import SVGGenerationRequest, SVGGenerationResponse

logger = logging.getLogger(__name__)
settings = get_settings()


# ============================================================================
# PROMPTS
# ============================================================================

SVG_SYSTEM_PROMPT = """Generate a simple SVG visualization. Keep it MINIMAL and FAST.

RULES:
- Under 1500 characters total
- viewBox="0 0 800 600"
- 3-5 simple shapes max
- 1 title, 2-3 labels
- Solid colors only (no gradients)
- English text only

Output ONLY raw SVG code. No explanations."""

SUMMARY_SYSTEM_PROMPT = """You are an educational slide summarizer.

Convert live transcript chunks into concise, classroom-style slide notes.

IMPORTANT: All output MUST be in English only.

Output requirements:
- Return plain text only (no code blocks)
- All text must be in English
- Use exactly this structure:
  Key Concepts
  - ...
  Key Details
  - ...
  Takeaways
  - ...
- Each bullet must be a direct educational statement
- Never use speaker-attribution wording such as:
  "the user stated", "the speaker said", "according to the transcript"
- Focus on concepts, definitions, mechanisms, examples, and implications
- Keep bullets concise and information-dense
- Do not invent facts that were not present in the transcript"""

GRAMMAR_SYSTEM_PROMPT = """You are a grammar correction assistant. Fix grammar, spelling, and punctuation.
Output ONLY the corrected text in English, nothing else. Preserve the original meaning exactly."""

ENHANCED_SVG_PROMPT_TEMPLATE = """Enhance and evolve this existing SVG visualization based on new details.

EXISTING SVG CODE:
{previous_svg}

ORIGINAL DESCRIPTION:
{previous_text}

NEW DETAILS TO ADD:
{new_text}

INSTRUCTIONS:
- Analyze the existing SVG structure and style
- Keep the same visual theme, colors, and overall layout
- Add new elements or modify existing ones to incorporate the new details
- Maintain SVG validity and the same viewBox dimensions
- Enhance details, add depth, or expand the scene based on new information
- Output only the complete updated SVG code"""


# ============================================================================
# LLM PROCESSOR CLASS
# ============================================================================

class LLMProcessor:
    """
    Processor for generating SVG visualizations and text processing using LangChain.
    Provides unified interface with automatic retries, fallbacks, and error handling.
    """

    def __init__(self, model: Optional[str] = None):
        """
        Initialize the LLM processor with LangChain models.

        Args:
            model: Model identifier, defaults to settings.llm_model
        """
        self.model = model or settings.llm_model
        self.claude_model = None
        self.openai_model = None
        self.openai_embeddings = None
        self.output_parser = StrOutputParser()
        self._initialize_models()

    def _initialize_models(self):
        """Initialize LangChain models with proper configuration."""
        # Initialize Claude model for SVG generation
        try:
            from langchain_anthropic import ChatAnthropic

            if settings.claude_key:
                self.claude_model = ChatAnthropic(
                    model=self.model if self.model.startswith("claude") else "claude-sonnet-4-6",
                    api_key=settings.claude_key,
                    max_tokens=2048,  # Minimal for fast SVGs
                    temperature=0.7,
                    max_retries=3,
                )
                logger.info(f"LangChain Claude model initialized: {self.model}")
            else:
                logger.warning("Claude API key not configured")
        except ImportError as e:
            logger.warning(f"langchain-anthropic not installed: {e}")
        except Exception as e:
            logger.error(f"Failed to initialize Claude model: {e}")

        # Initialize OpenAI model for fallback and utilities
        try:
            from langchain_openai import ChatOpenAI, OpenAIEmbeddings

            if settings.openai_api_key:
                self.openai_model = ChatOpenAI(
                    model="gpt-4o-mini",
                    api_key=settings.openai_api_key,
                    max_tokens=2048,  # Minimal for fast SVGs
                    temperature=0.7,
                    max_retries=3,
                )
                self.openai_embeddings = OpenAIEmbeddings(
                    model="text-embedding-3-small",
                    api_key=settings.openai_api_key,
                )
                logger.info("LangChain OpenAI models initialized")
            else:
                logger.warning("OpenAI API key not configured")
        except ImportError as e:
            logger.warning(f"langchain-openai not installed: {e}")
        except Exception as e:
            logger.error(f"Failed to initialize OpenAI models: {e}")

    def _get_primary_model(self):
        """Get the primary model based on configuration."""
        if self.model.startswith("claude") and self.claude_model:
            return self.claude_model
        elif self.openai_model:
            return self.openai_model
        return None

    def _get_model_with_fallback(self):
        """Get model with fallback chain for reliability."""
        primary = self._get_primary_model()
        if primary and self.openai_model and primary != self.openai_model:
            # Create fallback chain: primary -> openai
            return primary.with_fallbacks([self.openai_model])
        elif primary:
            return primary
        elif self.openai_model:
            return self.openai_model
        return None

    def _get_text_content(self, content) -> str:
        """Extract text from response content, handling both string and list formats."""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            # Claude can return list of content blocks
            text_parts = []
            for block in content:
                if isinstance(block, str):
                    text_parts.append(block)
                elif isinstance(block, dict) and block.get("type") == "text":
                    text_parts.append(block.get("text", ""))
                elif hasattr(block, "text"):
                    text_parts.append(block.text)
            return "".join(text_parts)
        return str(content)

    def _extract_svg(self, response_text) -> str:
        """Extract SVG code from LLM response, handling truncated responses."""
        # Ensure we have a string
        response_text = self._get_text_content(response_text)

        # First try to find complete SVG
        svg_pattern = r"<svg[\s\S]*?</svg>"
        match = re.search(svg_pattern, response_text, re.IGNORECASE)
        if match:
            return match.group(0)

        # Check if SVG was truncated (has opening but no closing tag)
        svg_start = re.search(r"<svg[^>]*>", response_text, re.IGNORECASE)
        if svg_start:
            logger.warning("SVG appears truncated (no closing tag), attempting to repair...")
            # Extract from <svg> to end and close any open tags
            svg_content = response_text[svg_start.start():]
            # Close the SVG tag
            if "</svg>" not in svg_content.lower():
                svg_content = svg_content.rstrip() + "\n</svg>"
            logger.info(f"Repaired truncated SVG, length: {len(svg_content)}")
            return svg_content

        logger.warning(f"No SVG tags found in LLM response. Response preview: {response_text[:500]}...")
        return response_text

    def _create_fallback_svg(self, text: str, error: str) -> str:
        """Create a fallback SVG when generation fails."""
        escaped_text = text[:50].replace("<", "&lt;").replace(">", "&gt;")
        escaped_error = str(error)[:100].replace("<", "&lt;").replace(">", "&gt;")

        return f"""<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">
  <rect width="400" height="300" fill="#f8f9fa" stroke="#dee2e6" stroke-width="2"/>
  <text x="200" y="130" text-anchor="middle" font-family="system-ui" font-size="14" fill="#6c757d">
    Unable to generate visualization
  </text>
  <text x="200" y="160" text-anchor="middle" font-family="system-ui" font-size="12" fill="#adb5bd">
    Input: {escaped_text}...
  </text>
  <text x="200" y="190" text-anchor="middle" font-family="system-ui" font-size="10" fill="#dc3545">
    {escaped_error}
  </text>
</svg>"""

    def _cosine_similarity(self, vec1: list[float], vec2: list[float]) -> float:
        """Calculate cosine similarity between two vectors."""
        import math
        dot_product = sum(a * b for a, b in zip(vec1, vec2))
        magnitude1 = math.sqrt(sum(a * a for a in vec1))
        magnitude2 = math.sqrt(sum(b * b for b in vec2))
        if magnitude1 == 0 or magnitude2 == 0:
            return 0.0
        return dot_product / (magnitude1 * magnitude2)

    async def check_topic_similarity(
        self,
        text1: str,
        text2: str,
        threshold: float = 0.75
    ) -> Tuple[bool, float]:
        """
        Check if two text segments are about the same topic using embeddings.
        Uses LangChain OpenAI embeddings for semantic similarity.

        Args:
            text1: First text segment
            text2: Second text segment
            threshold: Similarity threshold (0-1)

        Returns:
            Tuple of (is_similar: bool, similarity_score: float)
        """
        if not self.openai_embeddings:
            # Fallback: simple word overlap
            words1 = set(text1.lower().split())
            words2 = set(text2.lower().split())
            overlap = len(words1 & words2) / max(len(words1 | words2), 1)
            return overlap > 0.3, overlap

        try:
            # Use LangChain embeddings
            embeddings = await self.openai_embeddings.aembed_documents([text1, text2])
            similarity = self._cosine_similarity(embeddings[0], embeddings[1])
            is_similar = similarity >= threshold

            logger.info(
                f"Topic similarity: '{text1[:30]}...' vs '{text2[:30]}...' "
                f"= {similarity:.3f} ({'SIMILAR' if is_similar else 'DIFFERENT'})"
            )
            return is_similar, similarity

        except Exception as e:
            logger.error(f"Embedding similarity check error: {e}")
            # Fallback to word overlap
            words1 = set(text1.lower().split())
            words2 = set(text2.lower().split())
            overlap = len(words1 & words2) / max(len(words1 | words2), 1)
            return overlap > 0.3, overlap

    async def generate_svg(self, request: SVGGenerationRequest) -> SVGGenerationResponse:
        """
        Generate an SVG visualization from text description using LangChain.

        Args:
            request: SVG generation request with text and options

        Returns:
            SVG generation response containing the SVG code and metadata
        """
        model = self._get_model_with_fallback()
        if not model:
            logger.warning("No LLM model available, returning mock response")
            return await self._generate_mock_svg(request)

        try:
            # Build prompt
            prompt_parts = [f"Create a detailed SVG visualization for: {request.text}"]
            if request.style:
                prompt_parts.append(f"Style preferences: {request.style}")
            if request.context:
                prompt_parts.append(f"Additional context: {request.context}")
            user_prompt = "\n".join(prompt_parts)

            # Create messages
            messages = [
                SystemMessage(content=SVG_SYSTEM_PROMPT),
                HumanMessage(content=user_prompt),
            ]

            # Invoke with retry built into LangChain
            logger.info(f"[SVG_LLM] ========== SVG GENERATION START ==========")
            logger.info(f"[SVG_LLM] Model: {model}")
            logger.info(f"[SVG_LLM] Prompt: {user_prompt}")
            response = await model.ainvoke(messages)
            logger.info(f"[SVG_LLM] ========== FULL RESPONSE ==========")
            logger.info(f"[SVG_LLM] Response content:\n{response.content}")
            logger.info(f"[SVG_LLM] ========== END RESPONSE ==========")
            svg_code = self._extract_svg(response.content)
            logger.info(f"[SVG_LLM] Extracted SVG length: {len(svg_code)}, starts with <svg: {svg_code.strip().startswith('<svg')}")

            return SVGGenerationResponse(
                svg_code=svg_code,
                description=f"Visualization generated for: {request.text}",
                original_text=request.text,
            )

        except Exception as e:
            logger.error(f"SVG generation error: {e}", exc_info=True)
            return SVGGenerationResponse(
                svg_code=self._create_fallback_svg(request.text, str(e)),
                description=f"Error generating visualization: {e}",
                original_text=request.text,
            )

    async def generate_enhanced_svg(
        self,
        previous_text: str,
        new_text: str,
        previous_svg: Optional[str] = None,
        style: Optional[str] = None
    ) -> SVGGenerationResponse:
        """
        Generate an enhanced SVG that builds upon a previous visualization.

        Args:
            previous_text: Text from the previous visualization
            new_text: New text to incorporate
            previous_svg: The actual SVG code from the previous generation
            style: Optional style preferences

        Returns:
            SVG generation response with enhanced visualization
        """
        model = self._get_model_with_fallback()
        if not model:
            combined_text = f"{previous_text} {new_text}"
            return await self._generate_mock_svg(
                SVGGenerationRequest(text=combined_text, style=style)
            )

        try:
            if previous_svg:
                prompt = ENHANCED_SVG_PROMPT_TEMPLATE.format(
                    previous_svg=previous_svg,
                    previous_text=previous_text,
                    new_text=new_text,
                )
            else:
                prompt = f"""Create an enhanced SVG visualization that evolves and builds upon the existing concept.

Previous context: {previous_text}
New details: {new_text}

Instructions:
- Maintain the core visual theme from the previous context
- Add, enhance, or evolve elements based on the new details
- Create a cohesive visualization that combines both contexts"""

            if style:
                prompt += f"\nStyle preferences: {style}"

            messages = [
                SystemMessage(content=SVG_SYSTEM_PROMPT),
                HumanMessage(content=prompt),
            ]

            response = await model.ainvoke(messages)
            svg_code = self._extract_svg(response.content)
            combined_text = f"{previous_text} + {new_text}"

            logger.info(f"Enhanced SVG generated (with previous_svg: {previous_svg is not None})")

            return SVGGenerationResponse(
                svg_code=svg_code,
                description=f"Enhanced visualization: {new_text}",
                original_text=combined_text,
            )

        except Exception as e:
            logger.error(f"Enhanced SVG generation error: {e}")
            return SVGGenerationResponse(
                svg_code=self._create_fallback_svg(new_text, str(e)),
                description=f"Error generating enhanced visualization: {e}",
                original_text=new_text,
            )

    def _strip_attribution_phrases(self, text: str) -> str:
        """Remove narration/speaker-attribution phrasing from summary lines."""
        attribution_patterns = [
            r"\b(the )?(user|speaker|presenter)\s+"
            r"(stated|states|said|says|mentioned|mentions|noted|notes|"
            r"described|describes|explained|explains|shared|shares)( that)?\b",
            r"\baccording to (the )?(user|speaker|presenter|transcript)\b[:,]?",
            r"\b(the )?transcript\s+(stated|states|said|says|shows|indicates)( that)?\b",
            r"\bit was (stated|said|mentioned|noted|described|explained) that\b",
            r"\bfrom (the )?(user|speaker|transcript)\b[:,]?",
        ]

        normalized = text
        for pattern in attribution_patterns:
            normalized = re.sub(pattern, "", normalized, flags=re.IGNORECASE)

        normalized = re.sub(r"^\s*(that|about|regarding)\s+", "", normalized, flags=re.IGNORECASE)
        normalized = re.sub(r"\s+", " ", normalized).strip(" -:;,")
        return normalized

    def _format_structured_slide_summary(self, bullets: list[str]) -> str:
        """Format bullets into structured slide summary."""
        normalized_unique: list[str] = []
        seen: set[str] = set()

        for bullet in bullets:
            cleaned = self._strip_attribution_phrases(bullet)
            cleaned = re.sub(r"^[#>\-*]+", "", cleaned).strip()
            if not cleaned:
                continue
            key = cleaned.lower()
            if key in seen:
                continue
            seen.add(key)
            normalized_unique.append(cleaned)

        if not normalized_unique:
            normalized_unique = ["Core ideas are being captured in real time."]

        concept_bullets = normalized_unique[0:3]
        detail_bullets = normalized_unique[3:6]
        takeaway_bullets = normalized_unique[6:9]

        if not detail_bullets:
            detail_bullets = ["Additional supporting details will appear as more transcript is captured."]
        if not takeaway_bullets:
            takeaway_bullets = ["Practical implications will be summarized as the discussion continues."]

        sections = [
            ("Key Concepts", concept_bullets),
            ("Key Details", detail_bullets),
            ("Takeaways", takeaway_bullets),
        ]

        output_lines: list[str] = []
        for idx, (title, section_bullets) in enumerate(sections):
            output_lines.append(title)
            for line in section_bullets:
                output_lines.append(f"- {line}")
            if idx < len(sections) - 1:
                output_lines.append("")

        return "\n".join(output_lines)

    def _normalize_summary(self, summary_text: str, fallback: str) -> str:
        """Normalize summary output into slide-friendly bullet formatting."""
        cleaned = summary_text.strip()
        if not cleaned:
            return fallback

        lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
        if not lines:
            return fallback

        bullet_pattern = re.compile(r"^([*-]|\u2022|\d+[.)])\s+")
        heading_pattern = re.compile(
            r"^(#{1,6}\s*)?(key concepts?|key details?|takeaways?|summary|main ideas?)\s*:?\s*$",
            re.IGNORECASE,
        )
        normalized_bullets: list[str] = []

        for line in lines:
            if heading_pattern.match(line):
                continue

            line_match = bullet_pattern.match(line)
            if line_match:
                normalized_bullets.append(line[line_match.end():])
            else:
                candidates = re.split(r"(?<=[.!?])\s+", line)
                for candidate in candidates:
                    cleaned_candidate = self._strip_attribution_phrases(candidate)
                    if cleaned_candidate:
                        normalized_bullets.append(cleaned_candidate)

        bullets = normalized_bullets[:9]
        if not bullets:
            return fallback

        return self._format_structured_slide_summary(bullets)

    def _build_fallback_summary(self, cleaned: list[str]) -> str:
        """Build deterministic fallback summary when LLM fails."""
        if not cleaned:
            return self._format_structured_slide_summary(
                ["No transcript content is available yet."]
            )

        recent_text = " ".join(cleaned[-5:])
        sentence_candidates = re.split(r"(?<=[.!?])\s+", recent_text)
        bullets = [
            self._strip_attribution_phrases(sentence.strip())
            for sentence in sentence_candidates
            if sentence.strip()
        ]
        bullets = [bullet for bullet in bullets if bullet][:9]
        if not bullets:
            bullets = [self._strip_attribution_phrases(cleaned[-1][:220])]

        return self._format_structured_slide_summary(bullets)

    async def generate_brief_summary_with_debug(self, texts: list[str]) -> dict[str, Any]:
        """
        Generate a concise live summary using LangChain with debug metadata.
        Uses Claude as primary with OpenAI fallback.
        """
        cleaned = [text.strip() for text in texts if text and text.strip()]
        input_characters = sum(len(text) for text in cleaned)
        fallback_summary = self._build_fallback_summary(cleaned)

        if not cleaned:
            return {
                "summary": self._build_fallback_summary([]),
                "provider": "fallback",
                "model": "rules-based",
                "fallback_used": True,
                "input_characters": 0,
                "elapsed_ms": 0,
            }

        snippets = cleaned[:40]
        formatted_text = "\n".join(
            f"{idx + 1}. {snippet[:700]}" for idx, snippet in enumerate(snippets)
        )
        prompt = (
            "Convert this live transcript into educational slide notes.\n"
            "Use exactly these sections: Key Concepts, Key Details, Takeaways.\n"
            "Under each section, return concise bullets only.\n"
            "Do not use speaker-attribution wording.\n\n"
            f"{formatted_text}"
        )

        messages = [
            SystemMessage(content=SUMMARY_SYSTEM_PROMPT),
            HumanMessage(content=prompt),
        ]

        # Try Claude first
        if self.claude_model:
            started = time.perf_counter()
            try:
                # Use a faster model for summaries
                from langchain_anthropic import ChatAnthropic
                summary_model = ChatAnthropic(
                    model=settings.summary_llm_model,
                    api_key=settings.claude_key,
                    max_tokens=500,
                    temperature=0.2,
                    max_retries=2,
                )
                response = await summary_model.ainvoke(messages)
                raw_summary = self._get_text_content(response.content)
                summary = self._normalize_summary(raw_summary, fallback_summary)
                elapsed_ms = int((time.perf_counter() - started) * 1000)

                return {
                    "summary": summary,
                    "provider": "claude",
                    "model": settings.summary_llm_model,
                    "fallback_used": False,
                    "input_characters": input_characters,
                    "elapsed_ms": elapsed_ms,
                }
            except Exception as e:
                logger.error(f"Claude summary error: {e}")

        # Fallback to OpenAI
        if self.openai_model:
            started = time.perf_counter()
            try:
                from langchain_openai import ChatOpenAI
                summary_model = ChatOpenAI(
                    model="gpt-4o-mini",
                    api_key=settings.openai_api_key,
                    max_tokens=320,
                    temperature=0.2,
                    max_retries=2,
                )
                response = await summary_model.ainvoke(messages)
                raw_summary = self._get_text_content(response.content)
                summary = self._normalize_summary(raw_summary, fallback_summary)
                elapsed_ms = int((time.perf_counter() - started) * 1000)

                return {
                    "summary": summary,
                    "provider": "openai",
                    "model": "gpt-4o-mini",
                    "fallback_used": True,
                    "input_characters": input_characters,
                    "elapsed_ms": elapsed_ms,
                }
            except Exception as e:
                logger.error(f"OpenAI summary error: {e}")

        # Final fallback
        logger.warning("Summary generation falling back to deterministic formatter")
        return {
            "summary": fallback_summary,
            "provider": "fallback",
            "model": "rules-based",
            "fallback_used": True,
            "input_characters": input_characters,
            "elapsed_ms": 0,
        }

    async def generate_brief_summary(self, texts: list[str]) -> str:
        """Generate a short summary from user speech/text segments."""
        summary_payload = await self.generate_brief_summary_with_debug(texts)
        return str(summary_payload["summary"])

    async def correct_grammar(self, text: str) -> str:
        """
        Correct grammar and punctuation using LangChain.
        Uses a fast model for low-latency correction.
        """
        if not text or not text.strip() or len(text) < 5:
            return text

        model = self.openai_model  # Use OpenAI for fast grammar correction
        if not model:
            return text

        try:
            messages = [
                SystemMessage(content=GRAMMAR_SYSTEM_PROMPT),
                HumanMessage(content=text.strip()),
            ]
            response = await model.ainvoke(messages)
            corrected = self._get_text_content(response.content).strip()

            if not corrected:
                return text

            logger.debug(f"Grammar corrected: '{text[:50]}...' -> '{corrected[:50]}...'")
            return corrected

        except Exception as e:
            logger.error(f"Grammar correction error: {e}")
            return text

    async def _generate_mock_svg(self, request: SVGGenerationRequest) -> SVGGenerationResponse:
        """Generate a mock SVG for testing without API access."""
        escaped_text = request.text[:60].replace("<", "&lt;").replace(">", "&gt;")

        mock_svg = f"""<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgGradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#667eea;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#764ba2;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="400" height="300" fill="url(#bgGradient)"/>
  <circle cx="50" cy="50" r="30" fill="rgba(255,255,255,0.1)"/>
  <circle cx="350" cy="250" r="50" fill="rgba(255,255,255,0.1)"/>
  <text x="200" y="140" text-anchor="middle" font-family="system-ui" font-size="16" fill="white" font-weight="bold">
    Mock Visualization
  </text>
  <text x="200" y="170" text-anchor="middle" font-family="system-ui" font-size="12" fill="rgba(255,255,255,0.8)">
    {escaped_text}
  </text>
  <text x="200" y="270" text-anchor="middle" font-family="system-ui" font-size="10" fill="rgba(255,255,255,0.6)">
    Configure API keys for real generation
  </text>
</svg>"""

        return SVGGenerationResponse(
            svg_code=mock_svg,
            description="Mock visualization (API not configured)",
            original_text=request.text,
        )

    async def generate_svg_streaming(self, request: SVGGenerationRequest):
        """
        Generate SVG with streaming response.
        Yields partial SVG content as it is generated.
        """
        model = self._get_model_with_fallback()
        if not model:
            yield await self._generate_mock_svg(request)
            return

        try:
            prompt_parts = [f"Create an SVG visualization for: {request.text}"]
            if request.style:
                prompt_parts.append(f"Style preferences: {request.style}")
            user_prompt = "\n".join(prompt_parts)

            messages = [
                SystemMessage(content=SVG_SYSTEM_PROMPT),
                HumanMessage(content=user_prompt),
            ]

            # Use LangChain streaming
            async for chunk in model.astream(messages):
                if hasattr(chunk, 'content') and chunk.content:
                    yield chunk.content

        except Exception as e:
            logger.error(f"Streaming generation error: {e}")
            fallback = self._create_fallback_svg(request.text, str(e))
            yield fallback
