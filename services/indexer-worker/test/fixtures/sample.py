import os
from pkg.mod import thing, other as alias

THRESHOLD = 3


class Store:
    def get(self, key):
        return lookup(key, THRESHOLD)

    def put(self, key, value):
        self.get(key)


def lookup(key, n):
    return os.path.join(key, str(n))
