# Substitut minimal de PySide6 : Lunii.QT ne s'en sert, dans le chemin d'import
# d'un pack, que pour la base QObject de LuniiDevice, les signaux Qt (progression,
# journal) et QCoreApplication.translate. On évite d'installer PySide6 (Qt, ~100 Mo).
