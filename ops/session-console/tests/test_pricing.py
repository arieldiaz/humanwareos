import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pricing as P

# Synthetic rates: one model whose price changes on 2026-03-01.
TABLE = {'basis': P.BASIS, 'currency': 'USD', 'unit': 'per-million-tokens', 'models': {
    'model-a': [
        {'effectiveFrom': '2026-01-01', 'input': 2, 'output': 10, 'cacheRead': 0.2, 'cacheWrite': 2.5, 'source': 'synthetic'},
        {'effectiveFrom': '2026-03-01', 'input': 4, 'output': 20, 'cacheRead': 0.4, 'cacheWrite': 5, 'source': 'synthetic'},
    ],
}}
TOKENS = {'input': 1_000_000, 'output': 100_000, 'cacheRead': 2_000_000, 'cacheWrite': 400_000}


def report(model='provider/model-a', tokens=TOKENS, **updates):
    return dict({'status': 'unavailable', 'usageId': 'call-1', 'model': model, 'tokens': dict(tokens)}, **updates)


class PricingTest(unittest.TestCase):
    def test_amount_is_each_token_class_at_its_own_rate(self):
        priced = P.price(report(), '2026-01-15T12:00:00Z', TABLE)
        # 1M*2 + 0.1M*10 + 2M*0.2 + 0.4M*2.5, per million tokens.
        self.assertEqual((priced['status'], priced['amount'], priced['currency']), ('estimated', 4.4, 'USD'))
        self.assertEqual(priced['basisRef'], {'type': 'rate', 'id': 'list-price:model-a:2026-01-01'})
        self.assertEqual(priced['tokens'], TOKENS)
        self.assertEqual(P.price(report(model='model-a'), '2026-01-15T12:00:00Z', TABLE)['amount'], 4.4)
        self.assertEqual(P.price(report(tokens={key: 0 for key in TOKENS}), '2026-01-15T12:00:00Z', TABLE)['amount'], 0)

    def test_rate_in_effect_on_the_usage_date_applies(self):
        for day, expected, row in (('2026-01-01', 4.4, '2026-01-01'), ('2026-02-28', 4.4, '2026-01-01'),
                                   ('2026-03-01', 8.8, '2026-03-01'), ('2027-06-30', 8.8, '2026-03-01')):
            priced = P.price(report(), f'{day}T00:00:00Z', TABLE)
            self.assertEqual((priced['amount'], priced['basisRef']['id']), (expected, f'list-price:model-a:{row}'))
        # History before the first row is never priced backward.
        self.assertIsNone(P.rate('model-a', '2025-12-31', TABLE))
        self.assertEqual(P.price(report(), '2025-12-31T23:59:59Z', TABLE)['status'], 'unavailable')

    def test_missing_tokens_or_price_stay_unavailable(self):
        partial = {key: TOKENS[key] for key in ('input', 'output')}
        for cost in (report(model='provider/unpriced-model'), report(model=None), report(tokens=partial),
                     report(tokens={'total': 500}), report(tokens={})):
            priced = P.price(cost, '2026-01-15T12:00:00Z', TABLE)
            self.assertEqual(priced, cost)
            self.assertNotIn('amount', priced)
        exact = report(status='exact', amount=1.5, currency='USD', basisRef={'type': 'event', 'id': 'provider-report'})
        self.assertEqual(P.price(exact, '2026-01-15T12:00:00Z', TABLE), exact)

    def test_shipped_table_states_its_basis_and_rejects_ambiguous_rows(self):
        self.assertEqual((P.TABLE['basis'], P.TABLE['currency']), ('api-list-price-equivalent', 'USD'))
        self.assertTrue(all(row.get('verified') for rows in P.TABLE['models'].values() for row in rows))

        def load(change):
            table = copy.deepcopy(TABLE)
            change(table)
            with tempfile.NamedTemporaryFile('w', suffix='.json') as handle:
                json.dump(table, handle)
                handle.flush()
                return P.load(handle.name)

        self.assertEqual(load(lambda table: None)['models'].keys(), TABLE['models'].keys())
        for change in (lambda table: table.update(basis='invoice'),
                       lambda table: table['models']['model-a'].reverse(),
                       lambda table: table['models']['model-a'][1].update(effectiveFrom='2026-01-01'),
                       lambda table: table['models']['model-a'][0].pop('cacheWrite'),
                       lambda table: table['models']['model-a'][0].pop('source'),
                       lambda table: table['models'].update({'model-b': []})):
            with self.assertRaises(ValueError):
                load(change)


if __name__ == '__main__':
    unittest.main()
