"""Run standalone, or pass bundled adapter source as argv[1] from Rust."""
import pathlib
import sys
import types
import unittest

source = sys.argv.pop(1) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else pathlib.Path(__file__).with_name('image_prompting.py').read_text()
adapter = types.ModuleType('deas_image_prompting_test')
exec(compile(source, 'deas_image_prompting.py', 'exec'), adapter.__dict__)


class ContractTests(unittest.TestCase):
    def test_v1_api_and_lightweight_import(self):
        node = adapter.NODE_CLASS_MAPPINGS['DEAS_ImagePromptEncode']
        self.assertEqual(node.RETURN_TYPES, ('CONDITIONING', 'CONDITIONING'))
        self.assertEqual(node.FUNCTION, 'encode')
        schema = node.INPUT_TYPES()
        self.assertEqual(list(schema['required']), ['clip', 'prompt', 'negative_prompt'])
        self.assertEqual([v[0] for v in schema['required'].values()], ['CLIP', 'STRING', 'STRING'])
        self.assertEqual(schema['optional'], {f'image_{i}': ('IMAGE',) for i in range(1, 5)})
        self.assertIn('DEAS_ImagePromptEncode', adapter.NODE_DISPLAY_NAME_MAPPINGS)
        self.assertNotIn('torch', adapter.__dict__)

    def test_empty_references_fail_and_log_without_ml_dependencies(self):
        with self.assertLogs(adapter.__name__, level='ERROR') as captured:
            with self.assertRaises(ValueError):
                adapter.DEAS_ImagePromptEncode().encode(Clip(), 'private prompt', '')
        self.assertEqual(len(captured.records), 1)
        self.assertNotIn('private', captured.output[0])

    def test_failures_reach_host_log_without_sensitive_exception_text(self):
        from unittest.mock import patch
        node = adapter.DEAS_ImagePromptEncode()
        with patch.object(node, '_encode', side_effect=RuntimeError('private prompt /private/image.png')):
            with self.assertLogs(adapter.__name__, level='ERROR') as captured:
                with self.assertRaises(RuntimeError):
                    node.encode(Clip(), 'private prompt', 'private negative')
        self.assertEqual(len(captured.output), 1)
        message = captured.output[0]
        self.assertIn('DEAS_ImagePromptEncode', message)
        self.assertIn('encode', message)
        self.assertIn('RuntimeError', message)
        self.assertNotIn('private', message)
        self.assertIsNone(captured.records[0].exc_info)

    def test_known_comfy_cancellation_is_not_logged_as_failure(self):
        from unittest.mock import patch
        class Cancelled(Exception):
            pass
        module = types.ModuleType('comfy.model_management')
        module.InterruptProcessingException = Cancelled
        node = adapter.DEAS_ImagePromptEncode()
        for error in (Cancelled(), KeyboardInterrupt()):
            with patch.dict(sys.modules, {'comfy.model_management': module}):
                with patch.object(node, '_encode', side_effect=error):
                    with self.assertNoLogs(adapter.__name__, level='ERROR'):
                        with self.assertRaises(type(error)):
                            node.encode(Clip(), '', '')


try:
    import torch
    import comfy.utils
except ImportError:
    torch = None


class Clip:
    def __init__(self):
        self.calls = []
        self.results = []

    def tokenize(self, text, *, llama_template, images, prevent_empty_text):
        self.calls.append((text, llama_template, images, prevent_empty_text))
        return object()

    def encode_from_tokens_scheduled(self, tokens):
        result = [('conditioning', {'tokens': tokens})]
        self.results.append(result)
        return result


@unittest.skipIf(torch is None, 'requires installed torch and ComfyUI on PYTHONPATH')
class ImageTests(unittest.TestCase):
    def test_invalid_references_fail_before_resize_or_tokenization(self):
        from unittest.mock import patch
        invalid = [None, 'not an image', torch.zeros(4, 4, 3),
                   torch.zeros(2, 4, 4, 3), torch.zeros(0, 4, 4, 3),
                   torch.zeros(1, 0, 4, 3), torch.zeros(1, 4, 4, 2),
                   torch.zeros(1, 4, 4, 3, dtype=torch.uint8),
                   torch.full((1, 2, 2, 3), float('nan')),
                   torch.full((1, 2, 2, 3), float('inf')),
                   torch.full((1, 2, 2, 3), -0.1),
                   torch.full((1, 2, 2, 3), 1.1),
                   torch.zeros(1, 1, 1, 3).expand(1, 4097, 4096, 3)]
        for image in invalid:
            with self.subTest(shape=getattr(image, 'shape', None)):
                clip = Clip()
                with patch.object(comfy.utils, 'common_upscale') as resize:
                    with self.assertLogs(adapter.__name__, level='ERROR') as logs:
                        with self.assertRaises(ValueError):
                            adapter.DEAS_ImagePromptEncode().encode(clip, '', '', image_1=image)
                    self.assertEqual(len(logs.records), 1)
                    self.assertIn('ValueError', logs.output[0])
                    resize.assert_not_called()
                self.assertEqual(clip.calls, [])
        with patch.object(comfy.utils, 'common_upscale') as resize:
            with self.assertLogs(adapter.__name__, level='ERROR'):
                with self.assertRaises(ValueError):
                    adapter.DEAS_ImagePromptEncode().encode(Clip(), '', '', image_1=torch.zeros(1, 4, 4, 3), image_4=invalid[-1])
            resize.assert_not_called()

    def test_tokenizer_and_encoder_errors_propagate_with_redacted_host_logs(self):
        from unittest.mock import patch
        for method in ('tokenize', 'encode_from_tokens_scheduled'):
            clip = Clip()
            error = RuntimeError('private prompt /private/image.png')
            with patch.object(clip, method, side_effect=error):
                with self.assertLogs(adapter.__name__, level='ERROR') as logs:
                    with self.assertRaises(RuntimeError) as caught:
                        adapter.DEAS_ImagePromptEncode().encode(clip, 'private prompt', '', image_1=torch.zeros(1, 4, 4, 3))
            self.assertIs(caught.exception, error)
            self.assertEqual(len(logs.records), 1)
            self.assertNotIn('private', logs.output[0])

    def test_placeholders_bind_images_in_marker_order_in_each_branch(self):
        clip = Clip()
        images = [torch.full((1, 4, 4, 3), i / 4) for i in range(4)]
        adapter.DEAS_ImagePromptEncode().encode(
            clip, 'input_image_2 then input_image_1 input_image_1', 'input_image_4',
            **{f'image_{i + 1}': image for i, image in enumerate(images)},
        )
        marker = '<|vision_start|><|image_pad|><|vision_end|>'
        self.assertEqual(clip.calls[0][0], marker + ' then ' + marker + ' input_image_1Picture 3: ' + marker + 'Picture 4: ' + marker)
        self.assertEqual(clip.calls[1][0], marker + 'Picture 1: ' + marker + 'Picture 2: ' + marker + 'Picture 3: ' + marker)
        for call, order in zip(clip.calls, ([1, 0, 2, 3], [3, 0, 1, 2])):
            self.assertEqual(len(call[2]), 4)
            for image, index in zip(call[2], order):
                self.assertAlmostEqual(image.mean().item(), index / 4, delta=0.01)

    def test_actual_comfy_tokenizers_bind_numbered_pictures(self):
        from comfy.text_encoders.krea2 import Krea2Tokenizer
        from comfy.text_encoders.moss_image import MOSSImageTokenizer
        for tokenizer_type in (Krea2Tokenizer, MOSSImageTokenizer):
            tokenizer = tokenizer_type()

            class TokenizingClip(Clip):
                def tokenize(self, text, **kwargs):
                    return tokenizer.tokenize_with_weights(text, **kwargs)

                def encode_from_tokens_scheduled(self, tokens):
                    return [token[0]['data'].mean().item()
                            for blocks in tokens.values() for block in blocks for token in block
                            if isinstance(token[0], dict) and token[0].get('type') == 'image']

            result = adapter.DEAS_ImagePromptEncode().encode(
                TokenizingClip(), 'input_image_2 left, input_image_1 right', 'input_image_2',
                image_1=torch.full((1, 4, 4, 3), 0.2), image_2=torch.full((1, 4, 4, 3), 0.8),
            )
            for branch in result:
                self.assertEqual(len(branch), 2)
                for actual, expected in zip(branch, (0.8, 0.2)):
                    self.assertAlmostEqual(actual, expected, delta=0.01)

    def test_both_branches_receive_ordered_rgb_images_and_native_template(self):
        from unittest.mock import patch
        first = torch.full((1, 20, 40, 3), 0.2)
        second = torch.full((1, 40, 20, 4), 0.0)
        second[..., 3] = 0.5
        clip = Clip()
        with patch.object(comfy.utils, 'common_upscale', wraps=comfy.utils.common_upscale) as resize:
            result = adapter.DEAS_ImagePromptEncode().encode(clip, 'cat', '', image_1=first, image_3=second)
        self.assertEqual(result, tuple(clip.results))
        self.assertEqual(len(resize.call_args_list), 2)
        for call in resize.call_args_list:
            self.assertEqual(call.args[-2:], ('lanczos', 'disabled'))
        marker = '<|vision_start|><|image_pad|><|vision_end|>'
        self.assertEqual(clip.calls[0][0], 'catPicture 1: ' + marker + 'Picture 2: ' + marker)
        self.assertEqual(clip.calls[1][0], 'Picture 1: ' + marker + 'Picture 2: ' + marker)
        expected_template = '<|im_start|>system\nDescribe the image by detailing the color, shape, size, texture, quantity, text, spatial relationships of the objects and background:<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n'
        for _, template, images, prevent_empty in clip.calls:
            self.assertEqual(template, expected_template)
            self.assertIs(prevent_empty, True)
            self.assertEqual(len(images), 2)
            for image, value, ratio in zip(images, (0.2, 0.5), (2, 0.5)):
                self.assertEqual(image.shape[0], 1)
                self.assertEqual(image.shape[-1], 3)
                self.assertAlmostEqual(image.shape[2] / image.shape[1], ratio, delta=0.01)
                self.assertAlmostEqual(image.shape[1] * image.shape[2], 384 * 384, delta=1000)
                self.assertTrue(torch.allclose(image, torch.full_like(image, value), atol=0.01))
        for positive_image, negative_image in zip(clip.calls[0][2], clip.calls[1][2]):
            self.assertIs(positive_image, negative_image)
        self.assertTrue(torch.all(first == 0.2))
        self.assertTrue(torch.all(second[..., :3] == 0))


if __name__ == '__main__':
    unittest.main()
