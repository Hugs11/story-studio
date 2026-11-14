-- Verification du parcours et des callbacks sur un hote factice, pas un emulateur.
local folder = arg[0]:match("^(.*)/")
local callbacks, labels, update, feedback, exited, plays, loadResult, audioStatus
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
             assert(path == "intro.mp3" or path == "intro-stereo.mp3")
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

for _, branch in ipairs({"pont", "sentier"}) do
    start()
    click()
    advance(1)
    assert(plays == 1)
    assert(labels[2].text:find("Écoute"), "Un stop pendant load ne doit pas passer les choix")
    click()  -- Le clic ne doit pas court-circuiter la narration.
    assert(labels[2].text:find("Écoute"))
    feedback("play", 1)
    advance(640)
    audioStatus = "stop"
    feedback("stop", 16)
    if branch == "sentier" then callbacks[lv.EVENT_KEY](string.char(19)) end
    advance(4)
    click()
    assert(labels[3].text:find(branch))
    callbacks[lv.EVENT_KEY](string.char(10)) -- Double notification du meme clic.
    assert(not exited)
    advance(4)
    click()
    assert(exited)
    -- Firmware reel : rouvrir conserve le meme module, sans rappeler start/setup.
    assert(not labels[3].text:find("Chemin choisi"),
           "Relance FLAM : l'histoire conserve la premiere fin au lieu de proposer un nouveau depart")
    exited = false -- Reouverture par le firmware, sans start/setup ni nouveau module.
    advance(4)
    click()
    advance(1)
    assert(plays == 2, "La relance doit permettre d'ecouter et choisir a nouveau")
end
start(-1)
click()
advance(1)
assert(plays == 0 and labels[2].text:find("Audio indisponible"))
back_callback()
assert(exited)
start()
click()
advance(1)
assert(plays == 1 and labels[2].text:find("Écoute"))
audioStatus = "stop"
advance(161)
assert(labels[2].text:find("ne démarre pas"), "Une lecture qui s'arrete aussitot ne doit pas passer pour une narration terminee")
print("Parcours Lua : deux branches, relance du meme module, stop pendant load et arret premature verifies.")
