#!/usr/bin/env python3
"""
Roster generator for the Bright Memorial Health demo tenant.

Emits scripts/demo/roster.json — surgeons, block lines, rooms, units and the
service->unit map. The roster is committed so storyline references ("Dr. Vance",
"Ortho A") stay stable across reseeds and demo rehearsals.

All names are machine-generated from generic name parts combined by the seeded
RNG. No name is taken from any real roster, and none is hand-picked. Run the
market sanity check in DemoTenant.md section 2 before the first live demo.

Usage:
    python scripts/demo/roster.py --seed 42
"""

import argparse
import json
import os
import random

import demo_config as C

HERE = os.path.dirname(os.path.abspath(__file__))

# Generic name parts. Combined by the seeded RNG — never used as-is.
FIRST_NAMES = [
    'Marcus', 'Elena', 'Priya', 'Devin', 'Corinne', 'Rafael', 'Naomi', 'Theo',
    'Anika', 'Gerard', 'Lucia', 'Everett', 'Simone', 'Malik', 'Ingrid', 'Owen',
    'Talia', 'Desmond', 'Freya', 'Sanjay', 'Odette', 'Bram', 'Camille', 'Nils',
    'Rosalind', 'Hugo', 'Marisol', 'Cyrus', 'Delphine', 'Kwame', 'Beatrix',
    'Emil', 'Yara', 'Lars', 'Josephine', 'Idris', 'Colette', 'Ravi', 'Greta',
    'Soren', 'Adaeze', 'Matthias', 'Noor', 'Quinn', 'Vera', 'Emmett', 'Sylvie',
    'Tobias', 'Renata', 'Amos',
]

LAST_NAMES = [
    'Vance', 'Okonjo', 'Reinholt', 'Castellan', 'Merrick', 'Dalgaard', 'Ferreira',
    'Whitlock', 'Ashford', 'Nakamura', 'Bellweather', 'Quintero', 'Halloran',
    'Strand', 'Ferrante', 'Ovadia', 'Pemberton', 'Lindqvist', 'Marchetti',
    'Baptiste', 'Thackeray', 'Solano', 'Fairbourne', 'Devereaux', 'Kastellan',
    'Rhodes-Kim', 'Aldridge', 'Vasquez-Bell', 'Northcott', 'Ibarra', 'Sandoval',
    'Wexley', 'Petrosian', 'Chandra', 'Ellery', 'Voss', 'Mbeki', 'Rasmussen',
    'Tarrant', 'Cormier', 'Delacroix', 'Hargrove', 'Winslowe', 'Adeyemi',
    'Brannigan', 'Sartori', 'Kovalenko', 'Estrada', 'Fenwick', 'Aurelio',
]

MIDDLE_INITIALS = list('ABCDEFGHJKLMNPRSTVW')

# Surgeons per service — roughly proportional to that service's case volume.
SURGEONS_PER_SERVICE = {
    'Orthopedics':      9,
    'General Surgery':  8,
    'Urology':          6,
    'GYN':              5,
    'ENT':              5,
    'Spine':            4,
    'Robotics-General': 4,
    'Plastics':         3,
    'Colorectal':       2,
    'Vascular':         2,
}   # 48 total


def _make_names(rng, n):
    """n unique 'Last, First M' names from the seeded RNG."""
    seen, out = set(), []
    while len(out) < n:
        last  = rng.choice(LAST_NAMES)
        first = rng.choice(FIRST_NAMES)
        mid   = rng.choice(MIDDLE_INITIALS)
        name  = f'{last}, {first} {mid}'
        if name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def _volume_weights(rng, n):
    """
    Per-surgeon volume weights within a service, shaped so that across the whole
    roster the top ~8 surgeons carry ~45% of volume. A Zipf-ish 1/rank^0.85 gives
    that concentration once services are combined.
    """
    raw = [1.0 / ((i + 1) ** 0.85) for i in range(n)]
    jittered = [w * rng.uniform(0.88, 1.12) for w in raw]
    total = sum(jittered)
    return [w / total for w in jittered]


def build_roster(seed=C.DEFAULT_SEED):
    rng = random.Random(seed)

    total_surgeons = sum(SURGEONS_PER_SERVICE.values())
    names = _make_names(rng, total_surgeons)
    name_iter = iter(names)

    surgeons = []
    for service in C.SERVICES:
        n = SURGEONS_PER_SERVICE[service]
        weights = _volume_weights(rng, n)
        for rank in range(n):
            surgeons.append({
                'name':          next(name_iter),
                'service':       service,
                'rank_in_service': rank + 1,
                # share of this service's volume
                'service_share': round(weights[rank], 5),
                'roles':         [],
            })

    by_service = {}
    for s in surgeons:
        by_service.setdefault(s['service'], []).append(s)

    # ── Storyline cast (DemoTenant.md section 3) ─────────────────────────────
    # Flagged, not special-cased: these are ordinary roster entries whose roles
    # the generator reads when it applies the section 4 bends.
    cast = {}

    # ST-1: the chronically-light Thursday Ortho A block owner. The #2 ortho
    # surgeon, so the story is a real practice with real volume elsewhere.
    st1_owner = by_service['Orthopedics'][1]
    st1_owner['roles'].append('st1_light_block_owner')
    cast['st1_light_block_owner'] = st1_owner['name']

    # ST-1 counterweight: the Spine surgeon whose forward pipeline is surging.
    st1_spine = by_service['Spine'][0]
    st1_spine['roles'].append('st1_spine_surge')
    cast['st1_spine_surge'] = st1_spine['name']

    # ST-4: the high-add-on FCOT offender — visible when a human filters the
    # cases table, and the surgeon Briefs must name.
    st4_offender = by_service['Spine'][1]
    st4_offender['roles'].append('st4_fcot_offender')
    cast['st4_fcot_offender'] = st4_offender['name']

    # ST-5: the robotics surgeon whose turnovers stretch when the next case
    # belongs to someone else.
    st5_robot = by_service['Robotics-General'][0]
    st5_robot['roles'].append('st5_turnover_offender')
    cast['st5_turnover_offender'] = st5_robot['name']

    # ── Block lines: panel of surgeons per block ─────────────────────────────
    blocks = {}
    for name, site, room, dow, service in C.BLOCK_TEMPLATE:
        b = blocks.setdefault(name, {
            'block': name, 'site': site, 'rooms': [], 'weekdays': [],
            'services': [], 'panel': [],
        })
        if room not in b['rooms']:
            b['rooms'].append(room)
        if dow not in b['weekdays']:
            b['weekdays'].append(dow)
        if service not in b['services']:
            b['services'].append(service)

    for b in blocks.values():
        panel = []
        for service in b['services']:
            pool = by_service[service]
            # A block line is 2-4 surgeons from its service, top-of-list first.
            take = min(len(pool), 3 if len(b['weekdays']) > 1 else 2)
            panel += [s['name'] for s in pool[:take]]
        # Ortho A is the ST-1 practice: make sure its owner is on the panel.
        if b['block'] == 'Ortho A' and cast['st1_light_block_owner'] not in panel:
            panel.insert(0, cast['st1_light_block_owner'])
        # The Spine lines carry the ST-4 offender and the surge surgeon.
        if b['block'] in ('Spine', 'Spine B'):
            for n in (cast['st1_spine_surge'], cast['st4_fcot_offender']):
                if n not in panel:
                    panel.append(n)
        b['panel'] = panel
        b['weekdays'].sort()

    rooms = []
    for site, cfg in C.SITES.items():
        for r in cfg['rooms']:
            rooms.append({'room': r, 'site': site, 'abbr': cfg['abbr']})

    units = [
        {'unit': u, 'level_of_care': loc, 'staffed_beds': beds, 'dept_code': code}
        for u, loc, beds, code in C.UNITS
    ]

    return {
        'seed':        seed,
        'system_name': 'Bright Memorial Health',
        'sites':       list(C.SITES.keys()),
        'rooms':       rooms,
        'units':       units,
        'services':    C.SERVICES,
        'surgeons':    surgeons,
        'blocks':      [blocks[k] for k in sorted(blocks)],
        'service_unit_map': C.SERVICE_UNIT_MAP,
        'cast':        cast,
    }


def load_roster(path=None):
    path = path or os.path.join(HERE, 'roster.json')
    if not os.path.exists(path):
        raise FileNotFoundError(
            f'{path} not found — run: python scripts/demo/roster.py --seed 42'
        )
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def main():
    ap = argparse.ArgumentParser(description='Generate the demo tenant roster.')
    ap.add_argument('--seed', type=int, default=C.DEFAULT_SEED)
    ap.add_argument('--out',  default=os.path.join(HERE, 'roster.json'))
    args = ap.parse_args()

    roster = build_roster(args.seed)
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(roster, fh, indent=2)
        fh.write('\n')

    top = sorted(roster['surgeons'], key=lambda s: -s['service_share'])[:8]
    print(f"  Wrote {args.out}")
    print(f"  {len(roster['surgeons'])} surgeons, {len(roster['blocks'])} block lines, "
          f"{len(roster['rooms'])} rooms, {len(roster['units'])} units")
    print('  Storyline cast:')
    for role, name in roster['cast'].items():
        print(f'    {role:26s} {name}')
    print('  Sanity-check these names against the prospect market before the first demo.')


if __name__ == '__main__':
    main()
