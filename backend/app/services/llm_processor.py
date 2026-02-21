"""
llm processor service module.
handles communication with large language models to generate svg code
from natural language descriptions. this module is responsible for
constructing prompts, managing context, and parsing llm responses.
includes topic similarity detection for intelligent visualization updates.
"""

import logging
import re
from typing import Optional, Tuple

from app.config import get_settings
from app.models.schemas import SVGGenerationRequest, SVGGenerationResponse

logger = logging.getLogger(__name__)
settings = get_settings()


# prompt for checking topic similarity between two text segments
TOPIC_SIMILARITY_PROMPT = """you are a topic similarity analyzer. compare the two text segments below and determine if they are about the same general topic or theme.

respond with exactly one of these two options:
- "SIMILAR" - if the texts share the same general topic, theme, or subject matter (even if details differ)
- "DIFFERENT" - if the texts are about distinctly different topics or themes

examples:
- "a red car driving fast" vs "a blue sports car on a highway" = SIMILAR (both about cars)
- "a beautiful sunset over mountains" vs "cats playing with yarn" = DIFFERENT (nature scene vs animals)
- "explaining machine learning algorithms" vs "neural networks and deep learning" = SIMILAR (both about AI/ML)
- "cooking pasta with tomato sauce" vs "the history of ancient rome" = DIFFERENT (cooking vs history)

text 1: {text1}

text 2: {text2}

your response (SIMILAR or DIFFERENT):"""

# system prompt that instructs the llm on how to generate svg code
# this prompt is crucial for getting consistent, valid svg output
SVG_SYSTEM_PROMPT = """you are an expert svg visualization generator. your task is to create clean,
valid svg code based on natural language descriptions. follow these guidelines:

1. always output valid svg code that can be rendered in a browser
2. use a viewbox of "0 0 400 300" unless the description requires different dimensions
3. include descriptive comments in the svg to explain each element
4. use semantic grouping with <g> elements where appropriate
5. apply appropriate colors, gradients, and styles to make visualizations appealing
6. keep the svg code clean and well-formatted
7. for abstract concepts, create metaphorical or symbolic visualizations
8. for data descriptions, create appropriate charts or diagrams
9. always include a background element for context

output format:
- start with <svg> tag
- end with </svg> tag
- do not include any explanation outside the svg tags
- the svg must be self-contained and not reference external resources

examples of visualizations you might create:
- bar charts, line graphs, pie charts for data
- flowcharts and diagrams for processes
- abstract art for emotions or concepts
- icons and symbols for objects
- scene illustrations for descriptions"""


class LLMProcessor:
    """
    processor for generating svg visualizations using language models.
    this class manages the interaction with the llm api and handles
    prompt construction, response parsing, and error handling.
    """

    def __init__(self, model: Optional[str] = None):
        """
        initialize the llm processor with the specified model.

        args:
            model: model identifier, defaults to settings.llm_model
        """
        self.model = model or settings.llm_model
        self.client = None
        self._initialize_client()

    def _initialize_client(self):
        """
        initialize the openai client for llm api calls.
        sets up the async client with the configured api key.
        """
        try:
            from openai import AsyncOpenAI

            self.client = AsyncOpenAI(api_key=settings.openai_api_key)
            logger.info(f"llm processor initialized with model: {self.model}")
        except ImportError:
            logger.warning("openai package not installed, llm processor unavailable")
            self.client = None

    def _build_prompt(self, request: SVGGenerationRequest) -> str:
        """
        construct the user prompt from the generation request.
        combines the text description with any additional context or style preferences.

        args:
            request: svg generation request containing text and options

        returns:
            formatted prompt string for the llm
        """
        prompt_parts = [f"create an svg visualization for: {request.text}"]

        if request.style:
            prompt_parts.append(f"style preferences: {request.style}")

        if request.context:
            prompt_parts.append(f"additional context: {request.context}")

        return "\n".join(prompt_parts)

    def _extract_svg(self, response_text: str) -> str:
        """
        extract svg code from the llm response.
        handles cases where the llm includes additional text outside the svg tags.

        args:
            response_text: raw text response from the llm

        returns:
            extracted svg code, or the original text if no svg tags found
        """
        # pattern to match svg content including the tags
        svg_pattern = r"<svg[\s\S]*?</svg>"
        match = re.search(svg_pattern, response_text, re.IGNORECASE)

        if match:
            return match.group(0)

        # if no svg tags found, return the response as-is
        # this allows for debugging when the llm doesn't follow the format
        logger.warning("no svg tags found in llm response, returning raw response")
        return response_text

    def _create_fallback_svg(self, text: str, error: str) -> str:
        """
        create a fallback svg when generation fails.
        displays an error message in a styled svg format.

        args:
            text: original text that failed to generate
            error: error message to display

        returns:
            svg code containing the error message
        """
        # escape special characters for svg text content
        escaped_text = text[:50].replace("<", "&lt;").replace(">", "&gt;")
        escaped_error = str(error)[:100].replace("<", "&lt;").replace(">", "&gt;")

        return f"""<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">
  <!-- fallback svg displayed when generation fails -->
  <rect width="400" height="300" fill="#f8f9fa" stroke="#dee2e6" stroke-width="2"/>
  <text x="200" y="130" text-anchor="middle" font-family="system-ui" font-size="14" fill="#6c757d">
    unable to generate visualization
  </text>
  <text x="200" y="160" text-anchor="middle" font-family="system-ui" font-size="12" fill="#adb5bd">
    input: {escaped_text}...
  </text>
  <text x="200" y="190" text-anchor="middle" font-family="system-ui" font-size="10" fill="#dc3545">
    {escaped_error}
  </text>
</svg>"""

    def _cosine_similarity(self, vec1: list[float], vec2: list[float]) -> float:
        """
        calculate cosine similarity between two vectors.

        args:
            vec1: first embedding vector
            vec2: second embedding vector

        returns:
            cosine similarity score between 0 and 1
        """
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
        check if two text segments are about the same topic using embeddings.
        uses openai embeddings for fast semantic similarity comparison.
        much faster and cheaper than using a full llm call.

        args:
            text1: first text segment (previous visualization text)
            text2: second text segment (new text)
            threshold: similarity threshold (0-1), above this is considered similar

        returns:
            tuple of (is_similar: bool, similarity_score: float)
        """
        if not self.client:
            # fallback: simple word overlap check when client not available
            words1 = set(text1.lower().split())
            words2 = set(text2.lower().split())
            overlap = len(words1 & words2) / max(len(words1 | words2), 1)
            return overlap > 0.3, overlap

        try:
            # use openai embeddings model for fast similarity check
            # text-embedding-3-small is fast and cost-effective
            response = await self.client.embeddings.create(
                model="text-embedding-3-small",
                input=[text1, text2],
            )

            # extract embeddings
            embedding1 = response.data[0].embedding
            embedding2 = response.data[1].embedding

            # calculate cosine similarity
            similarity = self._cosine_similarity(embedding1, embedding2)
            is_similar = similarity >= threshold

            logger.info(
                f"topic similarity (embeddings): '{text1[:30]}...' vs '{text2[:30]}...' "
                f"= {similarity:.3f} ({'SIMILAR' if is_similar else 'DIFFERENT'})"
            )

            return is_similar, similarity

        except Exception as e:
            logger.error(f"embedding similarity check error: {e}")
            # fallback to simple word overlap on error
            words1 = set(text1.lower().split())
            words2 = set(text2.lower().split())
            overlap = len(words1 & words2) / max(len(words1 | words2), 1)
            return overlap > 0.3, overlap

    async def generate_svg(self, request: SVGGenerationRequest) -> SVGGenerationResponse:
        """
        generate an svg visualization from the given text description.
        sends the prompt to the llm and processes the response.

        args:
            request: svg generation request with text and options

        returns:
            svg generation response containing the svg code and metadata
        """
        if not self.client:
            logger.warning("llm client not initialized, returning mock response")
            return await self._generate_mock_svg(request)

        try:
            prompt = self._build_prompt(request)

            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": SVG_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.7,  # allow some creativity in visualizations
                max_tokens=2000,  # svg code can be lengthy
            )

            svg_code = self._extract_svg(response.choices[0].message.content)

            return SVGGenerationResponse(
                svg_code=svg_code,
                description=f"visualization generated for: {request.text}",
                original_text=request.text,
            )

        except Exception as e:
            logger.error(f"llm generation error: {e}")
            return SVGGenerationResponse(
                svg_code=self._create_fallback_svg(request.text, str(e)),
                description=f"error generating visualization: {e}",
                original_text=request.text,
            )

    async def generate_brief_summary(self, texts: list[str]) -> str:
        """
        generate a short summary from a list of user speech/text segments.
        uses a smaller model for lightweight, low-cost summarization.
        """
        cleaned = [text.strip() for text in texts if text and text.strip()]
        if not cleaned:
            return "No user speech content was provided."

        fallback_summary = (
            f"Captured {len(cleaned)} speech segments. "
            f"Latest content: {cleaned[-1][:180]}"
        )

        if not self.client:
            return fallback_summary

        try:
            # keep input bounded for fast summarization
            snippets = cleaned[:40]
            formatted_text = "\n".join(
                f"{idx + 1}. {snippet[:500]}" for idx, snippet in enumerate(snippets)
            )

            response = await self.client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You summarize user speech notes. "
                            "Return a simple, concise summary in plain text. "
                            "Keep it short (3-6 sentences). "
                            "Do not include markdown or code blocks."
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            "Summarize these speech notes:\n\n"
                            f"{formatted_text}"
                        ),
                    },
                ],
                temperature=0.2,
                max_tokens=220,
            )

            summary = (response.choices[0].message.content or "").strip()
            if not summary:
                return fallback_summary

            return summary
        except Exception as e:
            logger.error(f"summary generation error: {e}")
            return fallback_summary

    async def generate_enhanced_svg(
        self,
        previous_text: str,
        new_text: str,
        previous_svg: Optional[str] = None,
        style: Optional[str] = None
    ) -> SVGGenerationResponse:
        """
        generate an enhanced svg that builds upon a previous visualization.
        when previous_svg is provided, the llm can see the actual svg code
        and make more intelligent, targeted enhancements.

        args:
            previous_text: text from the previous visualization
            new_text: new text to incorporate
            previous_svg: the actual svg code from the previous generation
            style: optional style preferences

        returns:
            svg generation response with enhanced visualization
        """
        if not self.client:
            logger.warning("llm client not initialized, returning mock response")
            combined_text = f"{previous_text} {new_text}"
            return await self._generate_mock_svg(
                SVGGenerationRequest(text=combined_text, style=style)
            )

        try:
            # build the enhanced prompt with svg code if available
            if previous_svg:
                # include the actual svg so the llm can see and modify it
                enhanced_prompt = f"""enhance and evolve this existing svg visualization based on new details.

EXISTING SVG CODE:
{previous_svg}

ORIGINAL DESCRIPTION:
{previous_text}

NEW DETAILS TO ADD:
{new_text}

INSTRUCTIONS:
- analyze the existing svg structure and style
- keep the same visual theme, colors, and overall layout
- add new elements or modify existing ones to incorporate the new details
- maintain svg validity and the same viewbox dimensions
- enhance details, add depth, or expand the scene based on new information
- output only the complete updated svg code
"""
            else:
                # fallback to text-only prompt if no svg provided
                enhanced_prompt = f"""create an enhanced svg visualization that evolves and builds upon the existing concept.

previous context (base visualization theme):
{previous_text}

new details to incorporate:
{new_text}

instructions:
- maintain the core visual theme from the previous context
- add, enhance, or evolve elements based on the new details
- create a cohesive visualization that combines both contexts
- make the visualization more detailed and refined than a fresh start
- if new details add specificity, incorporate those specific elements
"""

            if style:
                enhanced_prompt += f"\nstyle preferences: {style}"

            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": SVG_SYSTEM_PROMPT},
                    {"role": "user", "content": enhanced_prompt},
                ],
                temperature=0.7,
                max_tokens=2000,
            )

            svg_code = self._extract_svg(response.choices[0].message.content)
            combined_text = f"{previous_text} + {new_text}"

            logger.info(f"enhanced svg generated (with previous_svg: {previous_svg is not None})")

            return SVGGenerationResponse(
                svg_code=svg_code,
                description=f"enhanced visualization: {new_text}",
                original_text=combined_text,
            )

        except Exception as e:
            logger.error(f"enhanced svg generation error: {e}")
            return SVGGenerationResponse(
                svg_code=self._create_fallback_svg(new_text, str(e)),
                description=f"error generating enhanced visualization: {e}",
                original_text=new_text,
            )

    async def _generate_mock_svg(
        self, request: SVGGenerationRequest
    ) -> SVGGenerationResponse:
        """
        generate a mock svg for testing without api access.
        creates a simple svg that displays the input text.

        args:
            request: svg generation request

        returns:
            mock svg response
        """
        escaped_text = request.text[:60].replace("<", "&lt;").replace(">", "&gt;")

        mock_svg = f"""<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">
  <!-- mock visualization for development and testing -->
  <defs>
    <linearGradient id="bgGradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#667eea;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#764ba2;stop-opacity:1" />
    </linearGradient>
  </defs>

  <!-- background with gradient -->
  <rect width="400" height="300" fill="url(#bgGradient)"/>

  <!-- decorative circles -->
  <circle cx="50" cy="50" r="30" fill="rgba(255,255,255,0.1)"/>
  <circle cx="350" cy="250" r="50" fill="rgba(255,255,255,0.1)"/>
  <circle cx="200" cy="150" r="80" fill="rgba(255,255,255,0.05)"/>

  <!-- main text display -->
  <text x="200" y="140" text-anchor="middle" font-family="system-ui" font-size="16" fill="white" font-weight="bold">
    mock visualization
  </text>
  <text x="200" y="170" text-anchor="middle" font-family="system-ui" font-size="12" fill="rgba(255,255,255,0.8)">
    {escaped_text}
  </text>

  <!-- status indicator -->
  <text x="200" y="270" text-anchor="middle" font-family="system-ui" font-size="10" fill="rgba(255,255,255,0.6)">
    configure openai api key for real generation
  </text>
</svg>"""

        return SVGGenerationResponse(
            svg_code=mock_svg,
            description="mock visualization (api not configured)",
            original_text=request.text,
        )

    async def generate_svg_streaming(
        self, request: SVGGenerationRequest
    ):
        """
        generate svg with streaming response.
        yields partial svg content as it is generated by the llm.
        useful for showing progress during generation.

        args:
            request: svg generation request

        yields:
            chunks of svg code as they are generated
        """
        if not self.client:
            yield await self._generate_mock_svg(request)
            return

        try:
            prompt = self._build_prompt(request)

            stream = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": SVG_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.7,
                max_tokens=2000,
                stream=True,
            )

            full_response = ""
            async for chunk in stream:
                if chunk.choices[0].delta.content:
                    content = chunk.choices[0].delta.content
                    full_response += content
                    yield content

        except Exception as e:
            logger.error(f"streaming generation error: {e}")
            fallback = self._create_fallback_svg(request.text, str(e))
            yield fallback
