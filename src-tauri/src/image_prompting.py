"""Bounded vision-prompt conditioning for Krea2 and MOSS Image.

Template/placeholder behavior adapted from SwarmUI, commit
 d74f8ce40d1e49161da61ddb74f87e6ebf11f7ad (SwarmText.py).
MIT License
Copyright (c) 2024-2025 Alex "mcmonkey" Goodwin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

# MOSS's native default differs; explicitly use Swarm's Krea template for vision insertion.
KREA2_TEMPLATE = '<|im_start|>system\nDescribe the image by detailing the color, shape, size, texture, quantity, text, spatial relationships of the objects and background:<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n'


class DEAS_ImagePromptEncode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            'required': {
                'clip': ('CLIP',),
                'prompt': ('STRING', {'multiline': True}),
                'negative_prompt': ('STRING', {'multiline': True}),
            },
            'optional': {f'image_{i}': ('IMAGE',) for i in range(1, 5)},
        }

    RETURN_TYPES = ('CONDITIONING', 'CONDITIONING')
    FUNCTION = 'encode'
    CATEGORY = 'DEAS/conditioning'

    def encode(self, clip, prompt, negative_prompt, image_1=None, image_2=None,
               image_3=None, image_4=None):
        try:
            return self._encode(clip, prompt, negative_prompt, (image_1, image_2, image_3, image_4))
        except Exception as error:
            import logging
            import sys
            # Core cancellation derives from BaseException; also respect already-loaded variants.
            interrupt = getattr(sys.modules.get('comfy.model_management'), 'InterruptProcessingException', ())
            if not isinstance(error, interrupt):
                logging.getLogger(__name__).error('DEAS_ImagePromptEncode encode failed (%s)', type(error).__name__)
            raise

    def _encode(self, clip, prompt, negative_prompt, references):
        references = [image for image in references if image is not None]
        if not references:
            raise ValueError('DEAS image prompting requires at least one reference image')
        import math
        import re
        import torch
        import comfy.utils
        for image in references:
            if (not isinstance(image, torch.Tensor) or image.ndim != 4
                    or image.shape[0] != 1 or image.shape[-1] not in (3, 4)
                    or min(image.shape[1:3]) < 1 or not image.is_floating_point()):
                raise ValueError('DEAS reference must be a single floating-point BHWC RGB/RGBA image')
            if image.shape[1] * image.shape[2] > 16 * 1024 * 1024:
                raise ValueError('DEAS reference exceeds the 16 megapixel limit')
            if not torch.isfinite(image).all() or image.min() < 0 or image.max() > 1:
                raise ValueError('DEAS reference pixels must be finite and between zero and one')

        images = []
        for image in references:
            if image.shape[-1] == 4:
                image = image[..., :3] * image[..., 3:] + (1.0 - image[..., 3:])
            height, width = image.shape[1:3]
            scale = math.sqrt(384 * 384 / (height * width))
            images.append(comfy.utils.common_upscale(
                image.movedim(-1, 1), max(1, round(width * scale)),
                max(1, round(height * scale)), 'lanczos', 'disabled',
            ).movedim(1, -1))

        results = []
        marker = '<|vision_start|><|image_pad|><|vision_end|>'
        for text in (prompt, negative_prompt):
            order = []

            def replace(match):
                index = int(match.group(1)) - 1
                if index >= len(images) or index in order:
                    return match.group(0)
                order.append(index)
                return marker

            text = re.sub(r'input_image_([1-4])(?!\d)', replace, text)
            for i in range(len(images)):
                if i not in order:
                    text += f'Picture {i + 1}: {marker}'
                    order.append(i)
            # Krea/MOSS tokenizers consume images in marker encounter order, not placeholder order.
            tokens = clip.tokenize(text, llama_template=KREA2_TEMPLATE,
                                   images=[images[i] for i in order], prevent_empty_text=True)
            results.append(clip.encode_from_tokens_scheduled(tokens))
        return tuple(results)


NODE_CLASS_MAPPINGS = {'DEAS_ImagePromptEncode': DEAS_ImagePromptEncode}
NODE_DISPLAY_NAME_MAPPINGS = {'DEAS_ImagePromptEncode': 'DEAS Image Prompt Encode'}
