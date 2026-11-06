import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('training', Path(__file__).parents[2] / 'scripts/train_lora.py')
training = importlib.util.module_from_spec(spec)
spec.loader.exec_module(training)

class Tokenizer:
    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):
        return ''.join(f'<{m["role"]}>{m["content"]}</end>' for m in messages) + ('<assistant>' if add_generation_prompt else '')
    def encode(self, text, add_special_tokens=False):
        return list(text.encode())

class TrainingMaskTests(unittest.TestCase):
    def test_only_final_response_is_supervised(self):
        row = {'prompt': [{'role': 'system', 'content': 'reglas'}, {'role': 'assistant', 'content': 'respuesta vieja'},
                          {'role': 'user', 'content': 'pregunta'}],
               'completion': [{'role': 'assistant', 'content': 'respuesta nueva'}]}
        encoded = training.encode_example(row, Tokenizer())
        supervised = bytes(v for v in encoded['labels'] if v != -100).decode()
        self.assertEqual(supervised, 'respuesta nueva</end>')
        self.assertEqual(len(encoded['input_ids']), len(encoded['labels']))
    def test_truncation_removes_old_context_not_target(self):
        row = {'prompt': [{'role': 'system', 'content': 'r'}, {'role': 'assistant', 'content': 'x' * 400},
                          {'role': 'user', 'content': 'ahora'}],
               'completion': [{'role': 'assistant', 'content': 'respuesta'}]}
        result = training.encode_example(row, Tokenizer(), max_length=100)
        self.assertIsNotNone(result)
        self.assertLessEqual(len(result['input_ids']), 100)
        self.assertEqual(bytes(v for v in result['labels'] if v != -100).decode(), 'respuesta</end>')
    def test_oversized_target_is_rejected_not_truncated(self):
        row = {'prompt': [{'role': 'user', 'content': 'q'}],
               'completion': [{'role': 'assistant', 'content': 'x' * 100}]}
        self.assertIsNone(training.encode_example(row, Tokenizer(), max_length=50))

if __name__ == '__main__':
    unittest.main()
