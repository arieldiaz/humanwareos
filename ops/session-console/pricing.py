"""API list-price equivalent for observed token usage.

Pure arithmetic over a dated public price table. The amount is what the observed
tokens would cost at API list price, not a bill: several harnesses run on
subscriptions. Tokens that were not observed are never estimated.
"""
from __future__ import annotations

from decimal import Decimal
import json
from pathlib import Path
import re

BASIS = 'api-list-price-equivalent'
TOKEN_CLASSES = ('input', 'output', 'cacheRead', 'cacheWrite')
DAY = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def load(path=None):
    with open(path or Path(__file__).with_name('model-prices.json'), encoding='utf-8') as handle:
        table = json.load(handle)
    if table.get('basis') != BASIS or table.get('currency') != 'USD' or table.get('unit') != 'per-million-tokens':
        raise ValueError('Price table must state its basis, currency and unit')
    for model, rows in table['models'].items():
        days = [row.get('effectiveFrom') for row in rows]
        if not rows or days != sorted(set(days)) or not all(isinstance(day, str) and DAY.fullmatch(day) for day in days):
            raise ValueError(f'Price rows for {model} need unique ascending effective dates')
        for row in rows:
            if not row.get('source') or not all(type(row.get(key)) in (int, float) and row[key] >= 0 for key in TOKEN_CLASSES):
                raise ValueError(f'Price row for {model} needs a source and a rate for every token class')
    return table


TABLE = load()


def model_id(model):
    """`provider/model` and a bare `model` name the same public list price."""
    return str(model or '').rsplit('/', 1)[-1]


def rate(model, day, table=None):
    """The row in effect for a model on a UTC day, or None when no row covers it."""
    rows = [row for row in (table or TABLE)['models'].get(model_id(model), []) if row['effectiveFrom'] <= day]
    return rows[-1] if rows else None


def price(cost, ts, table=None):
    """Add an amount to a usage report that has none, when its model and every token class are known."""
    tokens = cost.get('tokens') or {}
    row = rate(cost.get('model'), str(ts)[:10], table)
    if cost.get('status') != 'unavailable' or not row or any(type(tokens.get(key)) is not int for key in TOKEN_CLASSES):
        return cost
    amount = sum(Decimal(tokens[key]) * Decimal(str(row[key])) for key in TOKEN_CLASSES) / 1_000_000
    return dict(cost, status='estimated', amount=float(amount), currency=(table or TABLE)['currency'],
                basisRef={'type': 'rate', 'id': f"list-price:{model_id(cost['model'])}:{row['effectiveFrom']}"})
