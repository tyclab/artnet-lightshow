"""Stage 7 — what the track *feels* like."""

from dataclasses import dataclass, field

import numpy as np

from . import dsp


MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                          2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                          2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


# Several phrasings per subgenre, best match wins: one phrasing can miss ('disco' is also a room).
GENRE_PROMPTS = {
    'edm':       ('electronic dance music', 'house music',
                  'a four to the floor club track'),
    'dubstep':   ('dubstep', 'drum and bass', 'bass music with a heavy drop'),
    'trance':    ('trance music', 'uplifting trance with a long build-up'),
    'disco':     ('disco music', 'seventies disco with strings and four to the floor'),
    'hiphop':    ('hip hop music', 'rap over a beat', 'trap music'),
    'rock':      ('rock music', 'a rock band with electric guitars, bass and drums',
                  'indie rock'),
    'metal':     ('heavy metal', 'punk rock', 'aggressive distorted guitars and screamed vocals'),
    'pop':       ('pop music', 'a mainstream pop song with a sung chorus'),
    'funk':      ('funk music', 'soul and rhythm and blues', 'a funky groove with a slap bass'),
    'reggae':    ('reggae', 'ska', 'dub with an off-beat guitar skank'),
    'country':   ('country music', 'bluegrass', 'americana with acoustic guitar and fiddle'),
    'latin':     ('latin music', 'salsa, cumbia and reggaeton',
                  'brazilian music with bossa nova guitar'),
    'jazz':      ('jazz', 'blues', 'a swinging jazz combo with an upright bass'),
    'classical': ('classical music', 'an orchestra playing', 'opera and choral music'),
    'folk':      ('folk music', 'traditional acoustic music', 'a singer with an acoustic guitar'),
    'ambient':   ('ambient music', 'a slow atmospheric drone with no beat'),
}

# 0.1 puts GENRE_MIN_SCORE at a 0.10 cosine lead; test_genre.py pins the pairing.
GENRE_SOFTMAX_TEMPERATURE = 0.1

SUBGENRES = {
    'edm':       ['electronic dance music', 'house music', 'techno',
                  'dance music', 'electronica', 'electronic music'],
    'dubstep':   ['dubstep', 'drum and bass'],
    'trance':    ['trance music'],
    'disco':     ['disco'],
    'hiphop':    ['hip hop music', 'rapping'],
    'rock':      ['rock music', 'rock and roll', 'progressive rock',
                  'psychedelic rock', 'grunge', 'independent music'],
    'metal':     ['heavy metal', 'punk rock', 'noise music'],
    'pop':       ['pop music'],
    'funk':      ['funk', 'soul music', 'rhythm and blues'],
    'reggae':    ['reggae', 'ska'],
    'country':   ['country', 'bluegrass'],
    'latin':     ['music of latin america', 'salsa music', 'cumbia, quebradita',
                  'reggaeton', 'bossa nova', 'flamenco'],
    'jazz':      ['jazz', 'blues', 'swing music'],
    'classical': ['classical music', 'opera', 'choir', 'orchestra'],
    'folk':      ['folk music', 'acoustic guitar', 'traditional music',
                  'middle eastern music'],
    # No piano/gospel/christian music: they carried a Backstreet Boys track to ambient, i.e. the calm tier.
    'ambient':   ['ambient music', 'new-age music'],
}

# A 0.108 vs 0.105 near-tie once lit a whole track as calm; below these the signal-derived style decides.
GENRE_MIN_SCORE = 0.15
GENRE_MIN_MARGIN = 1.5

# Show-engine contract: dance strobes and chases, moderate strobes only on drops, rock sparing effects, calm never strobes.
GENRE_STYLE = {
    'edm': 'dance', 'dubstep': 'dance', 'trance': 'dance', 'disco': 'dance',
    'hiphop': 'moderate', 'pop': 'moderate', 'funk': 'moderate',
    'rock': 'rock', 'metal': 'rock', 'country': 'rock', 'reggae': 'rock',
    'jazz': 'calm', 'classical': 'calm', 'folk': 'calm', 'ambient': 'calm',
    'latin': 'calm',
}


@dataclass
class Perception:
    key: str = None
    scale: str = None
    key_strength: float = 0.0
    valence: float = 0.5
    arousal: float = 0.5
    danceability: float = 0.5
    kickiness: float = 0.5
    tension: float = 0.5
    genre: str = 'unknown'
    genre_confidence: float = 0.0
    genre_source: str = 'signal'
    style: str = 'unknown'
    subgenre_scores: dict = field(default_factory=dict)
    top_tags: list = field(default_factory=list)
    # Raw AudioSet probabilities for the band stage; not serialised.
    tags: dict = field(default_factory=dict)

    def to_dict(self):
        return {
            'key': self.key,
            'scale': self.scale,
            'keyStrength': round(self.key_strength, 3),
            'mood': {
                'valence': round(self.valence, 3),
                'arousal': round(self.arousal, 3),
                'danceability': round(self.danceability, 3),
                'kickiness': round(self.kickiness, 3),
                'tension': round(self.tension, 3),
            },
            'genre': {
                'label': self.genre,
                'confidence': round(self.genre_confidence, 3),
                # Kept beside `confidence`: the web client and cached documents read `labelConf`.
                'labelConf': round(self.genre_confidence, 3),
                'style': self.style,
                'source': self.genre_source,
                'subScores': {k: round(v, 3) for k, v in self.subgenre_scores.items()},
                'topTags': self.top_tags,
            },
        }



def estimate_key(chroma):
    """
    Correlate the track's average chroma against all 24 rotated key profiles.

    Returns (key, scale, strength). Strength is the margin between the best fit
    and the second best, not the raw correlation: a track that fits C major at
    0.9 and A minor at 0.89 has an ambiguous key, and the palette should not act
    as if it were certain.
    """
    if chroma is None or getattr(chroma, 'size', 0) == 0:
        return None, None, 0.0
    profile = np.mean(np.asarray(chroma, dtype=float), axis=1)
    if profile.size != 12 or np.sum(profile) <= 0:
        return None, None, 0.0
    profile = profile / np.sum(profile)

    scores = []
    for tonic in range(12):
        for name, template in (('major', MAJOR_PROFILE), ('minor', MINOR_PROFILE)):
            rotated = np.roll(template, tonic)
            rotated = rotated / np.sum(rotated)
            if np.std(rotated) < 1e-9 or np.std(profile) < 1e-9:
                continue
            correlation = float(np.corrcoef(profile, rotated)[0, 1])
            if np.isfinite(correlation):
                scores.append((correlation, tonic, name))
    if not scores:
        return None, None, 0.0

    scores.sort(reverse=True)
    best, tonic, scale = scores[0]
    runner_up = scores[1][0] if len(scores) > 1 else 0.0
    strength = dsp.clamp01(max(0.0, best) * (0.5 + 0.5 * max(0.0, best - runner_up) * 4))
    return KEY_NAMES[tonic], scale, round(strength, 3)



def estimate_mood(features, bands, rhythm, scale, key_strength, roles=None):
    """
    Valence and arousal, plus the two measures a lighting desk actually uses.

    Arousal is the easy one and the reliable one: loudness, brightness,
    rhythmic density and tempo all point the same way, and it is what decides
    how hard the rig works.

    Valence is the hard one. Mode (major/minor) is the strongest single cue and
    it is weak — plenty of minor-key music is joyful — so it is weighted by how
    confident the key estimate was, and blended with brightness and harmonic
    consonance rather than trusted on its own. The number it produces is a hue
    bias, never a decision on its own.
    """
    tempo = rhythm.bpm if rhythm.bpm > 0 else 120.0

    loudness = dsp.clamp01(float(np.mean(dsp.robust_norm(features.rms))) * 1.4)
    brightness = dsp.clamp01(
        float(np.mean(features.centroid)) / max(1.0, features.sample_rate / 6.0))
    density = dsp.clamp01(float(np.mean(rhythm.intensity)) * 1.3) \
        if rhythm.intensity.size else 0.5
    tempo_drive = dsp.clamp01((tempo - 60.0) / 110.0)

    arousal = dsp.clamp01(
        0.30 * loudness + 0.22 * density + 0.26 * tempo_drive + 0.22 * brightness)

    mode_bias = 0.0
    if scale == 'major':
        mode_bias = 0.5 * key_strength
    elif scale == 'minor':
        mode_bias = -0.5 * key_strength
    consonance = 1.0 - dsp.clamp01(float(np.mean(features.flatness)) * 6.0)
    valence = dsp.clamp01(
        0.5 + 0.30 * mode_bias + 0.22 * (brightness - 0.45) + 0.18 * (consonance - 0.5))

    beat_confidence = float(np.mean(rhythm.confidences)) if rhythm.confidences.size else 0.0
    tempo_fit = float(np.exp(-0.5 * ((tempo - 122.0) / 38.0) ** 2))
    danceability = dsp.clamp01(
        0.40 * beat_confidence + 0.25 * tempo_fit
        + 0.20 * rhythm.stability + 0.15 * density)

    # Kickiness reads the kick role too: the bass band alone reports a sustained bass line, not the drum.
    kick_band = bands.get('bass')
    kickiness = 0.5
    if kick_band is not None:
        tight_attack = 1.0 - dsp.clamp01((kick_band.attack_ms - 10.0) / 90.0)
        kickiness = dsp.clamp01(
            0.35 * kick_band.rhythmic + 0.25 * kick_band.percussive_ratio
            + 0.20 * tight_attack
            + 0.20 * (roles.scores.get('kick', 0.5) if roles is not None else 0.5))

    tension = dsp.clamp01(
        0.35 * brightness + 0.30 * dsp.clamp01(float(np.mean(features.flatness)) * 5.0)
        + 0.35 * (1.0 - float(np.mean(rhythm.confidences)) if rhythm.confidences.size else 0.5))

    return {
        'valence': valence, 'arousal': arousal, 'danceability': danceability,
        'kickiness': kickiness, 'tension': tension,
    }



def genre_prompts():
    """Every zero-shot prompt in one flat tuple, for the model adapter."""
    return tuple(prompt for prompts in GENRE_PROMPTS.values() for prompt in prompts)


def subgenre_scores_from_prompts(rows):
    """
    Fold zero-shot prompt similarities into one probability per subgenre.

    Each subgenre takes its best-matching prompt — a maximum rather than a mean,
    because a prompt that misses drags an average down without carrying any
    information, and only one phrasing has to land for the answer to be right.
    """
    similarity = {row['label']: float(row['score']) for row in rows or []
                  if isinstance(row, dict) and 'label' in row and 'score' in row}
    if not similarity:
        return {}
    best = {}
    for name, prompts in GENRE_PROMPTS.items():
        matched = [similarity[prompt] for prompt in prompts if prompt in similarity]
        if matched:
            best[name] = max(matched)
    if not best:
        return {}
    names = list(best)
    values = np.array([best[name] for name in names], dtype=float)
    if not np.all(np.isfinite(values)):
        return {}
    weights = np.exp((values - values.max()) / GENRE_SOFTMAX_TEMPERATURE)
    weights /= weights.sum()
    return {name: float(weight) for name, weight in zip(names, weights)}


def classify_genre(tags, mood, rhythm, genre_scores=None):
    """
    Decide a subgenre and a show style, from the best evidence available.

    Three tiers, in order: MuQ-MuLan's zero-shot scores over the subgenres
    themselves, then AudioSet tags folded into those subgenres, then tempo and
    arousal. The last is deliberately conservative — it will call a track
    `unknown` and let the show engine use arousal directly rather than guess a
    genre and light a ballad like a rave.
    """
    scores = subgenre_scores_from_prompts(genre_scores)
    source = 'muq-mulan'
    if not scores and tags:
        scores = {name: float(sum(tags.get(label, 0.0) for label in labels))
                  for name, labels in SUBGENRES.items()}
        source = 'panns'
    if not scores:
        return _style_from_signal(mood, rhythm)

    result = decide_genre(scores, mood, rhythm)
    result['subgenre_scores'] = scores
    result['top_tags'] = _top_tags(tags if source == 'panns' else scores)
    if result['genre_source'] == 'scores':
        result['genre_source'] = source
    return result


def decide_genre(scores, mood, rhythm):
    """
    Turn subgenre scores into a label and a show style.

    Split out from the tagging so the decision can be tested against the scores
    real tracks actually produced, without a 310 MB model in the loop.

    Two guards, both there because of the same asymmetry: of the four styles,
    `calm` is the only one that turns the show *off* — no strobes, no drops, no
    accents — so a wrong `calm` costs the whole track, while a wrong `dance`
    merely over-lights it. The thresholds and the veto below are not symmetric
    for that reason.
    """
    if not scores:
        return _style_from_signal(mood, rhythm)

    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    label, confidence = ranked[0]
    runner_up = ranked[1][1] if len(ranked) > 1 else 0.0

    confident = (confidence >= GENRE_MIN_SCORE
                 and confidence >= runner_up * GENRE_MIN_MARGIN)
    if not confident:
        return _style_from_signal(mood, rhythm)

    style = GENRE_STYLE.get(label, 'moderate')

    # Veto: a loud, danceable track is never lit as calm, whatever the tag says.
    if style == 'calm' and mood['arousal'] >= 0.70 and mood['danceability'] >= 0.60:
        style = _style_from_signal(mood, rhythm)['style']

    return {
        'genre': label,
        'genre_confidence': dsp.clamp01(confidence),
        'genre_source': 'scores',
        'style': style,
        'subgenre_scores': {},
        'top_tags': [],
    }


def _top_tags(tags, count=6):
    ordered = sorted(tags.items(), key=lambda kv: -kv[1])[:count]
    return [{'label': label, 'p': round(float(p), 3)} for label, p in ordered]


def _style_from_signal(mood, rhythm):
    """
    Style without a classifier: tempo, arousal and how steady the beat is.

    Not a genre guess — it returns `unknown` for the label, because saying
    "this is house" from a tempo is how a live band gets lit like a DJ set. It
    only commits to how hard the rig should work.
    """
    arousal = mood['arousal']
    dance = mood['danceability']
    tempo = rhythm.bpm

    if arousal >= 0.72 and dance >= 0.60 and 110 <= tempo <= 180:
        style = 'dance'
    elif arousal >= 0.62:
        style = 'moderate'
    elif arousal >= 0.42:
        style = 'rock'
    else:
        style = 'calm'
    return {
        'genre': 'unknown',
        'genre_confidence': 0.0,
        'genre_source': 'signal',
        'style': style,
        'subgenre_scores': {},
        'top_tags': [],
    }



def analyse(features, bands, rhythm, roles=None, tags=None,
            genre_scores=None) -> Perception:
    key, scale, strength = estimate_key(features.chroma)
    mood = estimate_mood(features, bands, rhythm, scale, strength, roles)
    genre = classify_genre(tags, mood, rhythm, genre_scores)
    return Perception(
        key=key, scale=scale, key_strength=strength,
        valence=mood['valence'], arousal=mood['arousal'],
        danceability=mood['danceability'], kickiness=mood['kickiness'],
        tension=mood['tension'],
        genre=genre['genre'], genre_confidence=genre['genre_confidence'],
        genre_source=genre['genre_source'],
        style=genre['style'], subgenre_scores=genre['subgenre_scores'],
        top_tags=genre['top_tags'], tags=tags or {},
    )
