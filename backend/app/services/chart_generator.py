"""
chart generator service module.
handles generation of analytical visualizations using matplotlib.
generates python code from natural language descriptions and executes it
to produce chart images (bar charts, pie charts, line graphs, etc.).
"""

import asyncio
import base64
import io
import logging
import re
import sys
import tempfile
from typing import Optional, Tuple

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# keywords and phrases that indicate a chart/analytical visualization request
CHART_KEYWORDS = [
    "bar chart", "bar graph", "histogram",
    "pie chart", "pie graph", "donut chart",
    "line chart", "line graph", "trend",
    "scatter plot", "scatter chart",
    "area chart", "area graph",
    "chart", "graph", "plot",
    "data visualization", "analytics",
    "statistics", "stats",
    "percentage", "percent",
    "comparison", "compare",
    "distribution", "breakdown",
    "metrics", "kpi",
    "sales data", "revenue",
    "growth", "decline",
]

# system prompt for generating matplotlib code
MATPLOTLIB_SYSTEM_PROMPT = """you are an expert data visualization developer. your task is to generate python matplotlib code that creates clean, professional charts based on natural language descriptions.

follow these guidelines:

1. always import matplotlib.pyplot as plt and numpy as np at the top
2. use a clean, modern style (use plt.style.use('seaborn-v0_8-whitegrid') or similar)
3. create a figure with appropriate size: fig, ax = plt.subplots(figsize=(10, 6))
4. use appealing colors - prefer color palettes like:
   - ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#ef4444']
   - or use plt.cm.viridis, plt.cm.plasma, etc.
5. always include:
   - clear title (ax.set_title)
   - axis labels where appropriate (ax.set_xlabel, ax.set_ylabel)
   - legend if multiple data series
6. use tight_layout() to prevent label cutoff
7. the code must save the figure to a bytes buffer, not show() it

if the user doesn't provide specific data, create realistic sample data that matches their description.

output format:
- output ONLY valid python code
- start with imports
- end with saving to buffer
- do not include any explanation outside the code
- do not use plt.show()

the code MUST end with this exact pattern to save the figure:
```
buf = io.BytesIO()
plt.savefig(buf, format='png', dpi=150, bbox_inches='tight', facecolor='white', edgecolor='none')
buf.seek(0)
plt.close()
```

example for "create a bar chart of fruit sales":
```python
import matplotlib.pyplot as plt
import numpy as np
import io

# use a clean style
plt.style.use('seaborn-v0_8-whitegrid')

# sample data based on description
fruits = ['Apples', 'Bananas', 'Oranges', 'Grapes', 'Strawberries']
sales = [45, 32, 28, 51, 38]

# create figure
fig, ax = plt.subplots(figsize=(10, 6))

# create bar chart with custom colors
colors = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#ef4444']
bars = ax.bar(fruits, sales, color=colors, edgecolor='white', linewidth=1.5)

# add value labels on bars
for bar, value in zip(bars, sales):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 1,
            str(value), ha='center', va='bottom', fontweight='bold')

# styling
ax.set_title('Fruit Sales Distribution', fontsize=16, fontweight='bold', pad=20)
ax.set_xlabel('Fruit Type', fontsize=12)
ax.set_ylabel('Sales (units)', fontsize=12)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)

plt.tight_layout()

# save to buffer
buf = io.BytesIO()
plt.savefig(buf, format='png', dpi=150, bbox_inches='tight', facecolor='white', edgecolor='none')
buf.seek(0)
plt.close()
```"""


class ChartGenerator:
    """
    generator for analytical visualizations using matplotlib.
    takes natural language descriptions and generates executable python code
    that produces chart images.
    """

    def __init__(self):
        """initialize the chart generator with llm client."""
        self.client = None
        self.model = settings.llm_model
        self._initialize_client()

    def _is_claude_model(self) -> bool:
        """check if the model is a claude model."""
        return self.model.startswith("claude")

    def _initialize_client(self):
        """initialize the llm client for code generation."""
        if self._is_claude_model():
            try:
                import anthropic
                self.client = anthropic.AsyncAnthropic(api_key=settings.claude_key)
                logger.info(f"chart generator initialized with claude model: {self.model}")
            except ImportError:
                logger.warning("anthropic package not installed, chart generator unavailable")
                self.client = None
        else:
            try:
                from openai import AsyncOpenAI
                self.client = AsyncOpenAI(api_key=settings.openai_api_key)
                logger.info("chart generator initialized with openai")
            except ImportError:
                logger.warning("openai package not installed, chart generator unavailable")
                self.client = None

    async def is_chart_request(self, text: str) -> Tuple[bool, float]:
        """
        determine if the text is requesting a chart/analytical visualization.
        uses keyword matching and optionally embeddings for accuracy.

        args:
            text: the user's text description

        returns:
            tuple of (is_chart: bool, confidence: float)
        """
        text_lower = text.lower()

        # first check for explicit chart keywords
        keyword_matches = sum(1 for kw in CHART_KEYWORDS if kw in text_lower)

        if keyword_matches >= 2:
            # strong indication of chart request
            return True, 0.95

        if keyword_matches == 1:
            # moderate indication - check for data-related words
            data_words = ["data", "numbers", "values", "amount", "count", "total", "average", "mean", "sum"]
            has_data_words = any(word in text_lower for word in data_words)
            if has_data_words:
                return True, 0.85
            return True, 0.7

        # check for numerical data patterns (e.g., "apples: 50, bananas: 30")
        number_pattern = r'\b\d+\b'
        numbers = re.findall(number_pattern, text)
        if len(numbers) >= 3:
            # multiple numbers might indicate data for a chart
            return True, 0.6

        return False, 0.0

    def _extract_python_code(self, response_text: str) -> str:
        """
        extract python code from the llm response.
        handles markdown code blocks and raw code.

        args:
            response_text: raw text response from the llm

        returns:
            extracted python code
        """
        # try to find python code block
        code_pattern = r"```python\s*([\s\S]*?)```"
        match = re.search(code_pattern, response_text)
        if match:
            return match.group(1).strip()

        # try generic code block
        code_pattern = r"```\s*([\s\S]*?)```"
        match = re.search(code_pattern, response_text)
        if match:
            return match.group(1).strip()

        # assume the whole response is code
        return response_text.strip()

    async def generate_chart_code(self, text: str) -> str:
        """
        generate matplotlib python code from a text description.

        args:
            text: natural language description of the chart

        returns:
            python code string that generates the chart
        """
        if not self.client:
            return self._create_fallback_code(text)

        try:
            if self._is_claude_model():
                # use anthropic api for claude models
                response = await self.client.messages.create(
                    model=self.model,
                    max_tokens=2000,
                    system=MATPLOTLIB_SYSTEM_PROMPT,
                    messages=[
                        {"role": "user", "content": f"create a chart visualization for: {text}"},
                    ],
                )
                code = self._extract_python_code(response.content[0].text)
            else:
                # use openai api for other models
                response = await self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": MATPLOTLIB_SYSTEM_PROMPT},
                        {"role": "user", "content": f"create a chart visualization for: {text}"},
                    ],
                    temperature=0.7,
                    max_tokens=2000,
                )
                code = self._extract_python_code(response.choices[0].message.content)

            logger.info(f"generated matplotlib code ({len(code)} chars)")
            return code

        except Exception as e:
            logger.error(f"chart code generation error: {e}")
            return self._create_fallback_code(text)

    def _create_fallback_code(self, text: str) -> str:
        """create fallback chart code when generation fails."""
        return f'''import matplotlib.pyplot as plt
import numpy as np
import io

plt.style.use('seaborn-v0_8-whitegrid')

fig, ax = plt.subplots(figsize=(10, 6))

# fallback sample data
categories = ['Category A', 'Category B', 'Category C', 'Category D']
values = [25, 35, 30, 10]
colors = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b']

ax.bar(categories, values, color=colors)
ax.set_title('Sample Chart\\n(Generated from: {text[:50]}...)', fontsize=14)
ax.set_ylabel('Values')

plt.tight_layout()

buf = io.BytesIO()
plt.savefig(buf, format='png', dpi=150, bbox_inches='tight', facecolor='white', edgecolor='none')
buf.seek(0)
plt.close()
'''

    async def execute_chart_code(self, code: str) -> Tuple[Optional[str], Optional[str]]:
        """
        execute matplotlib code and return the chart as base64 image.
        runs in a subprocess for safety.

        args:
            code: python code to execute

        returns:
            tuple of (base64_image: str or None, error: str or None)
        """
        # wrap the code to output base64
        wrapped_code = f'''
import sys
import base64

{code}

# output the image as base64
image_data = buf.getvalue()
print(base64.b64encode(image_data).decode('utf-8'))
'''

        try:
            # run in subprocess for safety
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
                logger.error(f"chart execution error: {error_msg}")
                return None, error_msg

            # get base64 image from stdout
            base64_image = stdout.decode('utf-8').strip()
            if base64_image:
                logger.info(f"chart generated successfully ({len(base64_image)} chars)")
                return base64_image, None
            else:
                return None, "no image output generated"

        except asyncio.TimeoutError:
            logger.error("chart execution timed out")
            return None, "chart generation timed out"
        except Exception as e:
            logger.error(f"chart execution exception: {e}")
            return None, str(e)

    async def generate_chart(self, text: str) -> dict:
        """
        generate a chart from text description.
        returns the chart as a base64 png image.

        args:
            text: natural language description

        returns:
            dict with 'image' (base64), 'code', 'description', and optionally 'error'
        """
        # generate the matplotlib code
        code = await self.generate_chart_code(text)

        # execute the code
        base64_image, error = await self.execute_chart_code(code)

        if error:
            # try to create a simple error chart
            logger.warning(f"retrying with simplified code due to error: {error}")
            fallback_code = self._create_fallback_code(text)
            base64_image, fallback_error = await self.execute_chart_code(fallback_code)

            if fallback_error:
                return {
                    "image": None,
                    "code": code,
                    "description": f"chart generation failed: {text}",
                    "error": f"original error: {error}, fallback error: {fallback_error}",
                }

        return {
            "image": base64_image,
            "code": code,
            "description": f"chart generated for: {text}",
            "error": None,
        }
