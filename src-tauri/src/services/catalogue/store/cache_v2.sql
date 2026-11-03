-- Association proposals are no longer a catalogue feature.
DROP TABLE suggestion_member;
DROP TABLE suggestion;
DROP TABLE unidentified_title;
PRAGMA user_version=2;
