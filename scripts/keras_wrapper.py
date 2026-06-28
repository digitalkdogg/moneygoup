"""
keras_wrapper.py — pickleable sklearn-like wrapper around a saved Keras model.

joblib pickles the wrapper (not the keras weights). At unpickle time it lazily
reloads the .keras file from disk. Keeps existing predict_long_term.py loader
code working — payload['model'].predict(X) behaves like a sklearn regressor.

Custom losses are intentionally NOT registered here — the loader uses
compile=False so the model can predict without needing the training-time loss
function present at inference.

Also exports `get_tanh_scaled_layer()` — a registered Keras custom layer
that applies tanh × per-element scale. Used to bound prediction outputs
to physically plausible ranges (e.g. ±70% for 6m, ±100% for 1y).
"""
from __future__ import annotations

import os


def get_tanh_scaled_layer():
    """Returns the TanhScaled class, registering it with Keras' serializable
    registry on first call so load_model() can deserialize it.

    Function-wrapped so importing this module doesn't force TF import for
    callers that only need KerasModelWrapper (TF import is slow)."""
    import tensorflow as tf
    from tensorflow.keras import layers
    from tensorflow.keras.saving import register_keras_serializable

    @register_keras_serializable(package='moneygoup', name='TanhScaled')
    class TanhScaled(layers.Layer):
        """Applies tanh elementwise, then multiplies by a fixed per-element scale."""

        def __init__(self, scales, **kwargs):
            super().__init__(**kwargs)
            self.scales = list(scales)

        def call(self, x):
            return tf.math.tanh(x) * tf.constant(self.scales, dtype=tf.float32)

        def get_config(self):
            cfg = super().get_config()
            cfg.update({'scales': self.scales})
            return cfg

    return TanhScaled


class KerasModelWrapper:
    def __init__(self, keras_path: str):
        self.keras_path = os.path.abspath(keras_path)
        self._model = None

    def _load(self):
        if self._model is None:
            import tensorflow as tf
            # Register custom layers BEFORE load_model walks the config tree.
            # No-op if v2 doesn't use TanhScaled, harmless side-effect otherwise.
            get_tanh_scaled_layer()
            # compile=False — we only predict, never retrain at load time.
            # This sidesteps having to register the custom joint loss.
            self._model = tf.keras.models.load_model(self.keras_path, compile=False)

    def predict(self, X):
        self._load()
        import numpy as np
        return np.asarray(self._model.predict(X, verbose=0))

    def __getstate__(self):
        return {'keras_path': self.keras_path}

    def __setstate__(self, state):
        self.keras_path = state['keras_path']
        self._model = None
