"""Grade actual fixture code from stdin; requires an existing NumPy interpreter.

This is a deterministic scalar-policy check, not a model evaluation. Indexability,
round trips, and scalar classes are independent observations. Never infer scalar
class from dtype=int, numerical equality, or a decision trailer.
"""

import json
import sys

import numpy as np


def grade(source, policy):
    namespace = {}
    exec(compile(source, "<scalar-decision-fixture>", "exec"), namespace)
    types = set()
    for shape in [(7,), (3, 4), (2, 3, 4)]:
        array = np.arange(np.prod(shape)).reshape(shape)
        for long_index in range(int(np.prod(shape))):
            coordinates = namespace["to_index_tuple"](long_index, shape)
            assert isinstance(coordinates, tuple)
            assert array[coordinates] == long_index, "indexability mismatch"
            assert namespace["to_long_index"](coordinates, shape) == long_index
            types.update(type(value) for value in coordinates)
    print(json.dumps({
        "indexable": True,
        "roundTrip": True,
        "pythonInts": all(kind is int for kind in types),
        "scalarClasses": sorted(kind.__module__ + "." + kind.__name__ for kind in types),
    }), flush=True)
    if policy == "python-int":
        assert all(kind is int for kind in types), "active Python-int policy requires type(value) is int"
    elif policy == "numpy-integer":
        assert all(issubclass(kind, np.integer) for kind in types), "active NumPy policy requires NumPy integers"
    else:
        raise ValueError("unknown scalar policy: " + policy)


if __name__ == "__main__":
    grade(sys.stdin.read(), sys.argv[1])
