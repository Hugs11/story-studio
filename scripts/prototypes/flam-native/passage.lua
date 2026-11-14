-- Aventure originale : rendu, commandes et cycle de vie du firmware.
local adventure = {}
local scenes = require("scenes")
local savegame = require("savegame")
local partie = scenes.initialPartie()
local hasPartie = false
local loadProblem, pendingSave
local choices, rows = {}, {}
local root, heading, body, first, second, hint, timer
local styles = {}
local selected, phase, ticks, lastClick, loading = 1, "ready", 0, -20, 0
local audioPending, audioAccepted, heardPlay = false, false, false
local loadResult, lastEvent, playedSecond, playStarted = "-", "-", 0, 0
local expectedDuration = 0
local playbackId = 0

local function text(parent, value, y, height, size)
    local obj = lv.label.new(parent)
    lv.obj.remove_style_all(obj)
    lv.obj.set_pos(obj, 12, y)
    lv.obj.set_size(obj, 296, height)
    lv.label.set_long_mode(obj, lv.LABEL_LONG_WRAP)
    lv.label.set_text(obj, value)
    local style = lv.style.new()
    lv.style.set_text_font(style, size)
    lv.style.set_text_color(style, lv.color.hex(0xf3f0df))
    styles[#styles + 1] = style
    lv.obj.add_style(obj, style, lv.STATE_DEFAULT)
    return obj
end

local function drawChoices()
    for index, row in ipairs(rows) do
        local option = choices[index]
        local prefix = index == selected and "> " or "  "
        if option and option.enabled == false then prefix = prefix .. "[x] " end
        lv.label.set_text(row, option and (prefix .. option.label) or "")
    end
end

local function storageError(kind)
    phase, selected = "storage-error", 1
    if kind == "uncertain" then
        choices = {{label = "Relire la partie", action = "reload"}, {label = "Bibliothèque", action = "leave"}}
        lv.label.set_text(heading, "Sauvegarde à vérifier")
        lv.label.set_text(body, "L'action a peut-être été sauvée.\nRelis la partie avant de continuer.")
    elseif kind == "read" then
        choices = {{label = "Réessayer", action = "reload"}, {label = "Bibliothèque", action = "leave"}}
        lv.label.set_text(heading, "Sauvegarde illisible")
        lv.label.set_text(body, "Ta partie n'a pas été effacée.\nRéessaie ou quitte l'aventure.")
    else
        choices = {{label = "Réessayer", action = "retry-save"}, {label = "Annuler", action = "cancel-save"},
                   {label = "Bibliothèque", action = "leave"}}
        lv.label.set_text(heading, "Sauvegarde impossible")
        lv.label.set_text(body, "Action non confirmée.\nRéessaie ou annule ce choix.")
    end
    lv.label.set_text(hint, "Aucune nouvelle partie automatique.")
    drawChoices()
end

local function restore()
    local restored, problem = savegame.read()
    if restored and not scenes.validPartie(restored) then problem = "invalid" end
    loadProblem = problem
    if not problem then
        pendingSave = nil
        if restored then partie, hasPartie = restored, true
        else partie, hasPartie = scenes.initialPartie(), false end
    end
end

local function commit(candidate)
    local ok, problem = savegame.write(candidate, hasPartie and partie or nil)
    if not ok then
        pendingSave = candidate
        if problem == "uncertain" then loadProblem = "uncertain" end
        storageError(problem == "uncertain" and "uncertain" or "write")
        return false
    end
    pendingSave = nil
    partie, hasPartie = candidate, true
    return true
end

local function showChoices()
    phase, selected = "scene", 1
    local view = scenes.describe(partie)
    choices = {}
    for _, choice in ipairs(view.choices) do choices[#choices + 1] = choice end
    choices[#choices + 1] = {label = "Inventaire", action = "inventory"}
    lv.label.set_text(heading, view.title)
    lv.label.set_text(body, view.body)
    lv.label.set_text(hint, "Tourne la molette, puis clique.")
    drawChoices()
end

local function inventory()
    phase, selected = "inventory", 1
    choices = {{label = "Retour à la scène", action = "scene"}}
    lv.label.set_text(heading, "Ton inventaire")
    lv.label.set_text(body, "Clé : " .. tostring(partie.keys))
    lv.label.set_text(hint, "Clique pour revenir à la scène.")
    drawChoices()
end

local function welcome()
    if loadProblem then storageError(loadProblem == "uncertain" and "uncertain" or "read"); return end
    phase, selected, audioPending, audioAccepted, heardPlay = "ready", 1, false, false, false
    playbackId = playbackId + 1
    choices = {{label = hasPartie and "Reprendre" or "Commencer", action = "intro"}}
    if hasPartie then choices[#choices + 1] = {label = "Recommencer", action = "confirm-restart"} end
    choices[#choices + 1] = {label = "Bibliothèque", action = "leave"}
    lv.label.set_text(heading, "La clé des lucioles")
    lv.label.set_text(body, "Explore, trouve une clé\net ouvre le passage du village.")
    lv.label.set_text(hint, "Retour : bibliothèque")
    drawChoices()
end

local function leave()
    -- La FLAM reprend le meme module sans rappeler setup : laisser un depart actif.
    welcome()
    audio.stop()
    goto_library()
end

local function diagnostics()
    local volume = audio.get_volume and audio.get_volume() or "?"
    lv.label.set_text(second, "V=" .. tostring(volume) .. " état=" .. tostring(audio.get_status()))
    lv.label.set_text(hint, "L=" .. tostring(loadResult) .. " E=" .. lastEvent .. " t=" .. tostring(playedSecond))
end

local function beginNarration()
    if not hasPartie and not commit(partie) then return end
    phase, audioPending, audioAccepted, heardPlay = "intro", true, false, false
    playbackId = playbackId + 1
    loading, loadResult, lastEvent, playedSecond, playStarted = 0, "-", "-", 0, ticks
    lv.label.set_text(heading, scenes.describe(partie).title)
    lv.label.set_text(body, "Écoute le début de cette scène...")
    for _, row in ipairs(rows) do lv.label.set_text(row, "") end
    diagnostics()
end

local function click()
    if ticks - lastClick < 4 then return end
    lastClick = ticks
    local option = choices[selected]
    if phase == "intro" or not option or option.enabled == false then return end
    if option.action == "intro" then
        beginNarration()
    elseif option.action == "reload" then restore(); welcome()
    elseif option.action == "retry-save" then
        if pendingSave and commit(pendingSave) then welcome() end
    elseif option.action == "cancel-save" then
        pendingSave = nil
        if hasPartie then showChoices() else welcome() end
    elseif option.action == "confirm-restart" then
        phase, selected = "confirm-restart", 1
        choices = {{label = "Annuler", action = "welcome"}, {label = "Oui, recommencer", action = "restart"}}
        lv.label.set_text(heading, "Recommencer cette partie ?")
        lv.label.set_text(body, "Ta progression sera remplacée.\nChoisis Annuler pour la garder.")
        lv.label.set_text(hint, "Un nouveau départ pour cette aventure.")
        drawChoices()
    elseif option.action == "restart" then
        if commit(scenes.initialPartie()) then beginNarration() end
    elseif option.action == "welcome" then welcome()
    elseif option.action == "leave" then leave()
    elseif option.action == "inventory" then inventory()
    elseif option.action == "scene" then showChoices()
    elseif option.destination then
        local candidate = {}
        for name, value in pairs(partie) do candidate[name] = value end
        candidate.scene = option.destination
        for name, value in pairs(option.effects or {}) do candidate[name] = value end
        if commit(candidate) then beginNarration() end
    end
end

local function key(event)
    local value = lv.event.get_key_value(event)
    if value == nil then return end
    local code = type(value) == "number" and value or string.byte(value)
    if code == 10 then click()
    elseif (code == 19 or code == 20) and phase ~= "intro" and #choices > 0 then
        selected = ((selected - 1 + (code == 19 and 1 or -1)) % #choices) + 1
        drawChoices()
    end
end

local function audioError(message)
    phase, selected = "audio-error", 1
    choices = {{label = "Continuer sans audio", action = "scene"}}
    lv.label.set_text(body, message)
    drawChoices()
    diagnostics()
end

local function feedback(status, second)
    if phase ~= "intro" then return end
    lastEvent = tostring(status)
    if audioAccepted and type(second) == "number" then playedSecond = math.max(playedSecond, second) end
    if status == "play" then heardPlay = true end
    -- Le chargement peut notifier l'arret de l'ancienne piste avant audio.play.
    if audioAccepted and heardPlay and status == "stop" then
        if playedSecond >= expectedDuration - 1 then
            showChoices()
        else
            audioError("Lecture arrêtée trop tôt.\nNote les valeurs ci-dessous.")
        end
    end
end

local function tick()
    ticks = ticks + 1
    if phase == "intro" or phase == "audio-error" then diagnostics() end
    if phase ~= "intro" then return end
    if audioAccepted then
        if audio.get_status() == "play" then heardPlay = true end
        if ticks - playStarted > 160 and audio.get_status() == "stop" then
            if heardPlay and playedSecond >= expectedDuration - 1 then
                showChoices()
            else
                audioError("La narration ne démarre pas.\nNote les valeurs ci-dessous.")
            end
        end
        return
    end
    if not audioPending then return end
    loading = loading + 1
    if audio.get_status() == "stop" then
        audioPending = false
        local path = scenes.describe(partie).audio
        local id = playbackId
        loadResult = audio.load(0, path, function(status, second)
            if id == playbackId then feedback(status, second) end
        end)
        if loadResult == 0 then
            expectedDuration = audio.duration and tonumber(audio.duration()) or nil
            if not expectedDuration or expectedDuration <= 1 then
                audioError("Durée audio indisponible.\nLa lecture n'est pas validée.")
                return
            end
            -- Accepter les evenements de lecture seulement apres le retour de load.
            audioAccepted, heardPlay, playStarted = true, false, ticks
            audio.play()
        else
            audioError("Audio indisponible.\nLe prototype n'est pas validé.")
        end
    elseif loading == 1 then
        audio.stop()
    elseif loading > 200 then
        audioError("Le lecteur audio ne répond pas.")
    end
end

function adventure.start()
    selected, phase, ticks, lastClick, loading = 1, "ready", 0, -20, 0
    audioPending, audioAccepted, heardPlay = false, false, false
    styles = {}
    -- La sortie hote gere la destruction. Ne pas nettoyer LVGL avant goto_library.
    back_callback = leave
    lv.group.remove_all_objs(document)
    lv.obj.clean(window)
    lv.group.set_editing(document, true)
    root = lv.obj.new(window)
    lv.obj.remove_style_all(root)
    lv.obj.set_size(root, 320, 212)
    lv.obj.clear_flag(root, lv.OBJ_FLAG_SCROLLABLE)
    local background = lv.style.new()
    lv.style.set_bg_color(background, lv.color.hex(0x132e32))
    lv.style.set_bg_opa(background, lv.OPA_COVER)
    styles[#styles + 1] = background
    lv.obj.add_style(root, background, lv.STATE_DEFAULT)
    heading = text(root, "La clé des lucioles", 8, 34, lv.font.nunito_bold_20)
    body = text(root, "Écoute le début de ton aventure...", 48, 62, lv.font.nunito_bold_16)
    first = text(root, "", 111, 26, lv.font.nunito_bold_16)
    second = text(root, "", 140, 26, lv.font.nunito_bold_16)
    local third = text(root, "", 169, 22, lv.font.nunito_bold_16)
    rows = {first, second, third}
    hint = text(root, "Bouton retour : bibliothèque.", 195, 17, lv.font.nunito_bold_12)
    lv.obj.add_event_cb(root, key, lv.EVENT_KEY)
    lv.obj.add_event_cb(root, click, lv.EVENT_CLICKED)
    lv.group.add_obj(document, root)
    timer = lv.timer.new(tick, 25, nil)
    restore()
    welcome()
end

return adventure
