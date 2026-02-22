"""
Chart generator service module using LangChain.
Handles generation of analytical visualizations using matplotlib.
Generates python code from natural language descriptions and executes it
to produce chart images (bar charts, pie charts, line graphs, etc.).
"""

import asyncio
import base64
import io
import logging
import re
import sys
from typing import Optional, Tuple

from langchain_core.messages import HumanMessage, SystemMessage

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# Keywords and phrases that indicate a chart/analytical visualization request
# Primary keywords - strong indicators of chart request
CHART_KEYWORDS_PRIMARY = [
    "bar chart", "bar graph", "histogram",
    "pie chart", "pie graph", "donut chart",
    "line chart", "line graph", "line plot",
    "scatter plot", "scatter chart", "scatter graph",
    "area chart", "area graph",
    "chart of", "graph of", "plot of",
    "make a chart", "create a chart", "draw a chart",
    "make a graph", "create a graph", "draw a graph",
    "visualize the data", "data visualization",
]

# Secondary keywords - need additional context
CHART_KEYWORDS_SECONDARY = [
    "chart", "graph", "plot",
    "analytics", "statistics", "stats",
    "percentage", "percent", "%",
    "comparison", "compare",
    "distribution", "breakdown",
    "metrics", "kpi",
    "sales", "revenue", "profit",
    "growth", "decline", "trend",
    "quarterly", "monthly", "yearly", "annual",
    "budget", "expenses", "costs",
    "performance", "results",
]

# Data indicator words - suggest numerical/tabular data
DATA_INDICATOR_WORDS = [
    "data", "numbers", "values", "figures",
    "amount", "count", "total", "sum",
    "average", "mean", "median",
    "rate", "ratio", "proportion",
    "increase", "decrease", "change",
]

# Combined for backwards compatibility
CHART_KEYWORDS = CHART_KEYWORDS_PRIMARY + CHART_KEYWORDS_SECONDARY

# System prompt for generating matplotlib code
MATPLOTLIB_SYSTEM_PROMPT = """You are a matplotlib code generator. You ONLY output valid Python code. You NEVER ask questions, provide explanations, or output anything except Python code.

CRITICAL RULES:
- ALWAYS output valid Python code, even if the request is vague or incomplete
- NEVER ask clarifying questions - just make reasonable assumptions and generate code
- NEVER include explanations, comments outside code, or conversational text
- If data is not specified, CREATE realistic sample data that fits the description
- Your entire response must be executable Python code

Code requirements:
1. Start with: import matplotlib.pyplot as plt, import numpy as np, import io
2. Use plt.style.use('seaborn-v0_8-whitegrid') for clean styling
3. Create figure: fig, ax = plt.subplots(figsize=(10, 6))
4. Use colors: ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#ef4444']
5. Include title (ax.set_title) and axis labels
6. Use plt.tight_layout()
7. End with the buffer save pattern (see below)

If request is vague like "show earnings" or "plot data":
- Create sample data (e.g., monthly earnings for 12 months)
- Use reasonable values
- Add a descriptive title

REQUIRED ending - your code MUST end with:
buf = io.BytesIO()
plt.savefig(buf, format='png', dpi=150, bbox_inches='tight', facecolor='white', edgecolor='none')
buf.seek(0)
plt.close()

DO NOT use plt.show() - it will break the code.

The code MUST end with this exact pattern to save the figure:
```
buf = io.BytesIO()
plt.savefig(buf, format='png', dpi=150, bbox_inches='tight', facecolor='white', edgecolor='none')
buf.seek(0)
plt.close()
```

Example for "create a bar chart of fruit sales":
```python
import matplotlib.pyplot as plt
import numpy as np
import io

# Use a clean style
plt.style.use('seaborn-v0_8-whitegrid')

# Sample data based on description
fruits = ['Apples', 'Bananas', 'Oranges', 'Grapes', 'Strawberries']
sales = [45, 32, 28, 51, 38]

# Create figure
fig, ax = plt.subplots(figsize=(10, 6))

# Create bar chart with custom colors
colors = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#ef4444']
bars = ax.bar(fruits, sales, color=colors, edgecolor='white', linewidth=1.5)

# Add value labels on bars
for bar, value in zip(bars, sales):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 1,
            str(value), ha='center', va='bottom', fontweight='bold')

# Styling
ax.set_title('Fruit Sales Distribution', fontsize=16, fontweight='bold', pad=20)
ax.set_xlabel('Fruit Type', fontsize=12)
ax.set_ylabel('Sales (units)', fontsize=12)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)

plt.tight_layout()

# Save to buffer
buf = io.BytesIO()
plt.savefig(buf, format='png', dpi=150, bbox_inches='tight', facecolor='white', edgecolor='none')
buf.seek(0)
plt.close()
```"""


class ChartGenerator:
    """
    Generator for analytical visualizations using matplotlib with LangChain.
    Takes natural language descriptions and generates executable python code
    that produces chart images. Uses LangChain for unified LLM interface with
    automatic retries and fallbacks.
    """

    def __init__(self):
        """Initialize the chart generator with LangChain models."""
        self.claude_model = None
        self.openai_model = None
        self.model_name = settings.llm_model
        self._initialize_models()

    def _initialize_models(self):
        """Initialize LangChain models for code generation."""
        # Initialize Claude model
        try:
            from langchain_anthropic import ChatAnthropic

            if settings.claude_key:
                self.claude_model = ChatAnthropic(
                    model=self.model_name if self.model_name.startswith("claude") else "claude-sonnet-4-6",
                    api_key=settings.claude_key,
                    max_tokens=2000,
                    temperature=0.7,
                    max_retries=3,
                )
                logger.info(f"Chart generator LangChain Claude model initialized: {self.model_name}")
            else:
                logger.warning("Claude API key not configured for chart generator")
        except ImportError as e:
            logger.warning(f"langchain-anthropic not installed: {e}")
        except Exception as e:
            logger.error(f"Failed to initialize Claude model for charts: {e}")

        # Initialize OpenAI model for fallback
        try:
            from langchain_openai import ChatOpenAI

            if settings.openai_api_key:
                self.openai_model = ChatOpenAI(
                    model="gpt-4o",
                    api_key=settings.openai_api_key,
                    max_tokens=2000,
                    temperature=0.7,
                    max_retries=3,
                )
                logger.info("Chart generator LangChain OpenAI model initialized")
            else:
                logger.warning("OpenAI API key not configured for chart generator")
        except ImportError as e:
            logger.warning(f"langchain-openai not installed: {e}")
        except Exception as e:
            logger.error(f"Failed to initialize OpenAI model for charts: {e}")

    def _get_model_with_fallback(self):
        """Get model with fallback chain for reliability."""
        primary = None

        # Determine primary model based on configuration
        if self.model_name.startswith("claude") and self.claude_model:
            primary = self.claude_model
        elif self.openai_model:
            primary = self.openai_model

        # Create fallback chain if both models available
        if primary and self.openai_model and primary != self.openai_model:
            return primary.with_fallbacks([self.openai_model])
        elif primary:
            return primary
        elif self.openai_model:
            return self.openai_model

        return None

    async def is_chart_request(self, text: str) -> Tuple[bool, float]:
        """
        Determine if the text is requesting a chart/analytical visualization.
        Uses tiered keyword matching for accuracy.

        Args:
            text: The user's text description

        Returns:
            Tuple of (is_chart: bool, confidence: float)
        """
        text_lower = text.lower()

        # Check for primary chart keywords (strong indicators)
        primary_matches = [kw for kw in CHART_KEYWORDS_PRIMARY if kw in text_lower]
        if primary_matches:
            logger.info(f"Chart detected (primary keywords): {primary_matches}")
            return True, 0.95

        # Check for secondary keywords
        secondary_matches = [kw for kw in CHART_KEYWORDS_SECONDARY if kw in text_lower]

        # Check for data indicator words
        data_matches = [w for w in DATA_INDICATOR_WORDS if w in text_lower]

        # If we have secondary keywords AND data indicators, likely a chart
        if len(secondary_matches) >= 1 and len(data_matches) >= 1:
            logger.info(f"Chart detected (secondary + data): {secondary_matches}, {data_matches}")
            return True, 0.85

        # If we have multiple secondary keywords, might be a chart
        if len(secondary_matches) >= 2:
            logger.info(f"Chart detected (multiple secondary): {secondary_matches}")
            return True, 0.75

        # Check for numerical data patterns (e.g., "apples: 50, bananas: 30")
        # This pattern catches "X is 50, Y is 30" or "X: 50, Y: 30" etc.
        number_pattern = r'\b\d+(?:\.\d+)?(?:\s*%|\s*percent)?\b'
        numbers = re.findall(number_pattern, text)

        # If we have numbers AND at least one secondary keyword
        if len(numbers) >= 2 and len(secondary_matches) >= 1:
            logger.info(f"Chart detected (numbers + keyword): {len(numbers)} numbers, {secondary_matches}")
            return True, 0.70

        # If we have many numbers, it's likely data for a chart
        if len(numbers) >= 4:
            logger.info(f"Chart detected (many numbers): {len(numbers)} numbers found")
            return True, 0.65

        logger.info(f"No chart detected. Secondary: {secondary_matches}, Data: {data_matches}, Numbers: {len(numbers)}")
        return False, 0.0

    def _extract_python_code(self, response_text: str) -> str:
        """
        Extract python code from the LLM response.
        Handles markdown code blocks and raw code.

        Args:
            response_text: Raw text response from the LLM

        Returns:
            Extracted python code
        """
        # Try to find python code block
        code_pattern = r"```python\s*([\s\S]*?)```"
        match = re.search(code_pattern, response_text)
        if match:
            return match.group(1).strip()

        # Try generic code block
        code_pattern = r"```\s*([\s\S]*?)```"
        match = re.search(code_pattern, response_text)
        if match:
            return match.group(1).strip()

        # Assume the whole response is code
        return response_text.strip()

    async def generate_chart_code(self, text: str) -> str:
        """
        Generate matplotlib python code from a text description using LangChain.

        Args:
            text: Natural language description of the chart

        Returns:
            Python code string that generates the chart
        """
        model = self._get_model_with_fallback()
        if not model:
            logger.warning("No LLM model available for chart code generation")
            return self._create_fallback_code(text)

        try:
            logger.info(f"Generating matplotlib code for: '{text[:100]}...'")
            messages = [
                SystemMessage(content=MATPLOTLIB_SYSTEM_PROMPT),
                HumanMessage(content=f"Generate Python matplotlib code for this chart. Use sample data if not specified. Output ONLY code, no questions or explanations:\n\n{text}"),
            ]

            # Invoke with built-in retry from LangChain
            response = await model.ainvoke(messages)
            raw_response = response.content
            logger.info(f"LLM response length: {len(raw_response)} chars")

            code = self._extract_python_code(raw_response)
            logger.info(f"Extracted matplotlib code ({len(code)} chars)")

            # Verify it looks like matplotlib code
            if "matplotlib" in code or "plt" in code or "import" in code:
                logger.info("Code contains matplotlib imports - valid chart code")
                return code
            else:
                # LLM returned something that's not code (question, explanation, etc.)
                logger.warning("LLM did not return valid code - using fallback")
                logger.warning(f"Invalid response preview: {code[:200]}...")
                return self._create_fallback_code(text)

        except Exception as e:
            logger.error(f"Chart code generation error: {e}", exc_info=True)
            return self._create_fallback_code(text)

    def _create_fallback_code(self, text: str) -> str:
        """Create fallback chart code when generation fails."""
        # Escape single quotes in text for the f-string
        escaped_text = text[:50].replace("'", "\\'")
        return f'''import matplotlib.pyplot as plt
import numpy as np
import io

plt.style.use('seaborn-v0_8-whitegrid')

fig, ax = plt.subplots(figsize=(10, 6))

# Fallback sample data
categories = ['Category A', 'Category B', 'Category C', 'Category D']
values = [25, 35, 30, 10]
colors = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b']

ax.bar(categories, values, color=colors)
ax.set_title('Sample Chart\\n(Generated from: {escaped_text}...)', fontsize=14)
ax.set_ylabel('Values')

plt.tight_layout()

buf = io.BytesIO()
plt.savefig(buf, format='png', dpi=150, bbox_inches='tight', facecolor='white', edgecolor='none')
buf.seek(0)
plt.close()
'''

    async def execute_chart_code(self, code: str) -> Tuple[Optional[str], Optional[str]]:
        """
        Execute matplotlib code and return the chart as base64 image.
        Runs in a subprocess for safety.

        Args:
            code: Python code to execute

        Returns:
            Tuple of (base64_image: str or None, error: str or None)
        """
        # Wrap the code to output base64
        wrapped_code = f'''
import sys
import base64

{code}

# Output the image as base64
image_data = buf.getvalue()
print(base64.b64encode(image_data).decode('utf-8'))
'''

        try:
            # Run in subprocess for safety
            process = await asyncio.create_subprocess_exec(
                sys.executable if hasattr(sys, 'executable') else 'python3',
                '-c', wrapped_code,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=30.0  # 30 second timeout
            )

            if process.returncode != 0:
                error_msg = stderr.decode('utf-8').strip()
                logger.error(f"Chart execution FAILED (exit code {process.returncode})")
                logger.error(f"Error output: {error_msg[:500]}")
                return None, error_msg

            # Get base64 image from stdout
            base64_image = stdout.decode('utf-8').strip()
            if base64_image:
                logger.info(f"CHART GENERATED SUCCESSFULLY - matplotlib image ({len(base64_image)} bytes base64)")
                return base64_image, None
            else:
                logger.error("Chart execution produced no output")
                return None, "No image output generated"

        except asyncio.TimeoutError:
            logger.error("Chart execution timed out")
            return None, "Chart generation timed out"
        except Exception as e:
            logger.error(f"Chart execution exception: {e}")
            return None, str(e)

    async def generate_chart(self, text: str) -> dict:
        """
        Generate a chart from text description.
        Returns the chart as a base64 png image.

        Args:
            text: Natural language description

        Returns:
            Dict with 'image' (base64), 'code', 'description', and optionally 'error'
        """
        # Generate the matplotlib code
        code = await self.generate_chart_code(text)

        # Execute the code
        base64_image, error = await self.execute_chart_code(code)

        if error:
            # Try to create a simple fallback chart
            logger.warning(f"Retrying with simplified code due to error: {error}")
            fallback_code = self._create_fallback_code(text)
            base64_image, fallback_error = await self.execute_chart_code(fallback_code)

            if fallback_error:
                return {
                    "image": None,
                    "code": code,
                    "description": f"Chart generation failed: {text}",
                    "error": f"Original error: {error}, fallback error: {fallback_error}",
                }

        return {
            "image": base64_image,
            "code": code,
            "description": f"Chart generated for: {text}",
            "error": None,
        }
