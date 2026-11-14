-- Verification du parcours et des callbacks sur un hote factice, pas un emulateur.
local folder = arg[0]:match("^(.*)/")
package.path = folder .. "/?.lua;" .. package.path
local callbacks, labels, update, feedback, exited, plays, loadResult, audioStatus, loadedPath
local saves = {}
local rejectWrite, rejectRead, discardWrite = false, false, false
local function copy(value)
    if type(value) ~= "table" then return value end
    local result = {}
    for key, item in pairs(value) do result[key] = copy(item) end
    return result
end
progression = {
    load = function(slot)
        if rejectRead then error("lecture refusee") end
        return copy(saves[slot] or {})
    end,
    save = function(slot, value)
        if rejectWrite then return false end
        if discardWrite then return end
        saves[slot] = copy(value)
    end,
}
progression.save("temoin", {texte = "autre aventure intacte"})
window, document = {}, {}
lv = {obj = {}, label = {}, style = {}, group = {}, timer = {}, color = {}, font = {},
      LABEL_LONG_WRAP = 1, EVENT_KEY = 2, EVENT_CLICKED = 3, STATE_DEFAULT = 0,
      OBJ_FLAG_SCROLLABLE = 1, OPA_COVER = 255, event = {}}
for _, name in ipairs({"remove_style_all", "set_pos", "set_size", "clear_flag", "add_style", "clean"}) do
    lv.obj[name] = function() end
end
for _, name in ipairs({"set_text_font", "set_text_color", "set_bg_color", "set_bg_opa"}) do
    lv.style[name] = function() end
end
for _, name in ipairs({"remove_all_objs", "set_editing", "add_obj"}) do
    lv.group[name] = function() end
end
lv.obj.new = function() return {} end
lv.style.new = function() return {} end
lv.color.hex = function(value) return value end
lv.label.new = function() local label = {}; labels[#labels + 1] = label; return label end
lv.label.set_long_mode = function() end
lv.label.set_text = function(label, text) label.text = text end
lv.obj.add_event_cb = function(_, callback, event) callbacks[event] = callback end
lv.event.get_key_value = function(event) return event end
lv.timer.new = function(callback) update = callback; return {} end
audio = {get_status = function() return audioStatus end,
         get_volume = function() return 50 end,
         stop = function() audioStatus = "stop" end,
         load = function(_, path, callback)
             assert(path:match("%-stereo%.mp3$"))
             loadedPath = path
             feedback = callback
             callback("stop", 0) -- Arret synchrone de l'ancienne piste pendant load.
             return loadResult
         end,
         play = function() plays = plays + 1; audioStatus = "play" end}
goto_library = function() exited = true end

local function start(result)
    callbacks, labels, exited, plays, loadResult = {}, {}, false, 0, result or 0
    audioStatus = "stop"
    local adventure = dofile(folder .. "/passage.lua")
    adventure.start()
    return adventure
end
local function advance(count) for _ = 1, count do update() end end
local function click() callbacks[lv.EVENT_CLICKED]() end

local function visible()
    local lines = {}
    for _, label in ipairs(labels) do lines[#lines + 1] = label.text or "" end
    return table.concat(lines, "\n")
end
local function expect(text)
    assert(visible():find(text, 1, true), "Texte attendu : " .. text .. "\nEcran :\n" .. visible())
end
local function choose(label)
    for _ = 1, 12 do
        for _, row in ipairs(labels) do
            if row.text == "> " .. label then advance(4); click(); return end
        end
        callbacks[lv.EVENT_KEY](string.char(19))
    end
    error("Choix absent : " .. label .. "\n" .. visible())
end
local function narration()
    advance(1)
    assert(plays > 0)
    expect("Écoute")
    feedback("play", 1)
    advance(640)
    audioStatus = "stop"
    feedback("stop", 16)
end

start()
click()
narration()
choose("Voir la porte")
expect("Ouvrir - nécessite une clé")
choose("Inventaire")
expect("Clé : 0")
choose("Retour à la scène")
expect("Ouvrir - nécessite une clé")
choose("Retour à la clairière")
expect("Explorer le coffre")
print("OK : porte conditionnelle et inventaire vide consultable sans impasse")

choose("Explorer le coffre")
choose("Prendre la clé")
callbacks[lv.EVENT_KEY](string.char(10)) -- Seconde notification du meme appui.
expect("Le coffre est vide")
choose("Inventaire")
expect("Clé : 1")
choose("Retour à la scène")
choose("Retour à la clairière")
choose("Explorer le coffre")
expect("Le coffre est vide")
choose("Retour à la clairière")
choose("Voir la porte")
choose("Ouvrir avec la clé")
expect("La porte est ouverte")
choose("Inventaire")
expect("Clé : 0")
choose("Retour à la scène")
choose("Traverser la porte")
expect("Fin de l'aventure")
choose("Retour à la clairière")
choose("Voir la porte")
expect("La porte est ouverte")
print("OK : recompense unique, consommation coherente et porte durablement ouverte")

start() -- Nouvelle instance Lua, avec le stockage hote conserve.
expect("Reprendre")
choose("Reprendre")
narration()
assert(loadedPath == "porte-stereo.mp3", "Reprendre doit relire le son de la scene retrouvee, pas l'introduction")
expect("La porte est ouverte")
choose("Inventaire")
expect("Clé : 0")
choose("Retour à la scène")
choose("Retour à la clairière")
choose("Explorer le coffre")
expect("Le coffre est vide")
print("OK : une nouvelle instance retrouve la porte ouverte et le coffre vide")

back_callback()
expect("Reprendre")
choose("Recommencer")
expect("Recommencer cette partie ?")
choose("Annuler")
choose("Reprendre")
narration()
expect("Le coffre est vide")
back_callback()
choose("Recommencer")
choose("Oui, recommencer")
narration()
choose("Inventaire")
expect("Clé : 0")
choose("Retour à la scène")
choose("Voir la porte")
expect("Ouvrir - nécessite une clé")
choose("[x] Ouvrir - nécessite une clé")
expect("La porte est fermée")
choose("Retour à la clairière")
choose("Explorer le coffre")
choose("Prendre la clé")
start()
choose("Reprendre")
narration()
choose("Inventaire")
expect("Clé : 1")
choose("Retour à la scène")
expect("Le coffre est vide")
back_callback()
choose("Reprendre")
narration()
choose("Inventaire")
expect("Clé : 1")
print("OK : reprise avec cle, nouvelle partie explicite et relance du meme module")

choose("Retour à la scène")
choose("Retour à la clairière")
choose("Voir la porte")
rejectWrite = true
choose("Ouvrir avec la clé")
expect("Sauvegarde impossible")
choose("Annuler")
choose("Inventaire")
expect("Clé : 1")
choose("Retour à la scène")
rejectWrite = false
choose("Ouvrir avec la clé")
expect("La porte est ouverte")
rejectRead = true
start()
expect("Sauvegarde illisible")
rejectRead = false
choose("Réessayer")
choose("Reprendre")
narration()
expect("La porte est ouverte")
print("OK : ecriture refusee et lecture interrompue ne reinitialisent pas la partie")

local intact = copy(saves)
progression.save("lucioles", {schema = 99, scene = "porte", keys = 0, chest = 1, door = 1})
start()
expect("Sauvegarde illisible")
assert(not visible():find("> Commencer", 1, true), "Une version inconnue ne doit pas ecraser la partie")
saves = copy(intact)
choose("Réessayer")
choose("Reprendre")
narration()
expect("La porte est ouverte")
print("OK : une sauvegarde incompatible est signalee avant de proposer une nouvelle partie")

discardWrite = true
choose("Retour à la clairière")
expect("Sauvegarde impossible")
choose("Annuler")
expect("La porte est ouverte")
discardWrite = false
choose("Retour à la clairière")
expect("Explorer le coffre")
print("OK : une ecriture sans effet est detectee par relecture, sans avancer silencieusement")

start(-1)
choose("Reprendre")
advance(1)
expect("Audio indisponible")
choose("Continuer sans audio")
expect("Explorer le coffre")
back_callback()
expect("Reprendre")
assert(exited)
start()
choose("Reprendre")
advance(1)
expect("Écoute") -- Le stop synchrone de load ne doit pas avancer.
audioStatus = "stop"
advance(161)
expect("La narration ne démarre pas")
choose("Continuer sans audio")
expect("Explorer le coffre")
print("OK : erreurs audio explicites et sortie utilisable sans perte de partie")

back_callback()
choose("Recommencer")
choose("Oui, recommencer")
narration()
start()
choose("Reprendre")
narration()
choose("Inventaire")
expect("Clé : 0")
choose("Retour à la scène")
choose("Voir la porte")
expect("La porte est fermée")
assert(progression.load("temoin").texte == "autre aventure intacte")
print("OK : sauvegarde avant acquisition et temoin d'une autre aventure preserves")
