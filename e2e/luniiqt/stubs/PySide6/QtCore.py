# Voir __init__.py. Les messages émis par `signal_logger` sont collectés dans LOG
# sous forme (niveau, texte) pour que l'oracle les classe en erreurs/avertissements.
LOG = []


class _Emitter:
    def __init__(self, name):
        self.name = name

    def emit(self, *args):
        if self.name == 'signal_logger' and len(args) >= 2:
            LOG.append((args[0], str(args[1])))

    def connect(self, *_a, **_k):
        pass


class Signal:
    def __init__(self, *types):
        self.name = None

    def __set_name__(self, owner, name):
        self.name = name

    def __get__(self, obj, objtype=None):
        return _Emitter(self.name)


class QObject:
    def __init__(self, *a, **k):
        pass


class QCoreApplication:
    @staticmethod
    def translate(_ctx, text, *_a, **_k):
        return text


class QFile:  # seulement pour story_load_db (base tierce), jamais appelé ici
    ReadOnly = 1
    Text = 2

    def __init__(self, *a):
        pass

    def open(self, *a):
        return False


class QTextStream:
    def __init__(self, *a):
        pass
