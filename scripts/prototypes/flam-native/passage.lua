-- Aventure originale. API hote LVGL/audio, sans framework tiers ni sauvegarde.
local adventure = {}
local root, heading, body, first, second, hint, timer
local styles = {}
local selected, phase, ticks, lastClick, loading = 1, "ready", 0, -20, 0
local profile, audioPending, audioAccepted, heardPlay = 2, false, false, false
local loadResult, lastEvent, playedSecond, playStarted = "-", "-", 0, 0

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

local function showChoices()
    phase = "choice"
    lv.label.set_text(body, "Quel chemin veux-tu explorer ?")
    lv.label.set_text(first, (selected == 1 and "> " or "  ") .. "Le pont des lucioles")
    lv.label.set_text(second, (selected == 2 and "> " or "  ") .. "Le sentier des renards")
    lv.label.set_text(hint, "Tourne la molette, puis clique.")
end

local function finish()
    phase = "end"
    lv.label.set_text(heading, "Ton aventure commence !")
    if selected == 1 then
        lv.label.set_text(body, "Les lucioles illuminent le pont.\nTu retrouves le village endormi.")
        lv.label.set_text(first, "Chemin choisi : le pont")
    else
        lv.label.set_text(body, "Un renard te guide entre les arbres.\nLe village apparaît au loin.")
        lv.label.set_text(first, "Chemin choisi : le sentier")
    end
    lv.label.set_text(second, "Fin du prototype")
    lv.label.set_text(hint, "Clique pour revenir à la bibliothèque.")
end

local function welcome()
    phase, selected, audioPending, audioAccepted, heardPlay = "ready", 1, false, false, false
    lv.label.set_text(heading, "Lucioles - diagnostic 2")
    lv.label.set_text(body, "Clique pour écouter l'aventure.\nPuis choisis ton chemin.")
    lv.label.set_text(first, profile == 2 and "> Audio B : stéréo" or "> Audio A : mono original")
    lv.label.set_text(second, "Molette : changer le test audio")
    lv.label.set_text(hint, "Retour : bibliothèque")
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

local function click()
    if ticks - lastClick < 4 then return end
    lastClick = ticks
    if phase == "ready" then
        phase, audioPending, audioAccepted, heardPlay = "intro", true, false, false
        loading, loadResult, lastEvent, playedSecond, playStarted = 0, "-", "-", 0, ticks
        lv.label.set_text(body, "Écoute le début de ton aventure...")
        lv.label.set_text(first, "")
        diagnostics()
    elseif phase == "choice" then finish()
    elseif phase == "end" then leave()
    elseif phase == "audio-error" then showChoices() end
end

local function key(event)
    local value = lv.event.get_key_value(event)
    if value == nil then return end
    local code = type(value) == "number" and value or string.byte(value)
    if code == 10 then click()
    elseif code == 19 or code == 20 then
        if phase == "choice" then
            selected = selected == 1 and 2 or 1
            showChoices()
        elseif phase == "ready" then
            profile = profile == 1 and 2 or 1
            welcome()
        end
    end
end

local function feedback(status, second)
    if phase ~= "intro" then return end
    lastEvent = tostring(status)
    if status == "play" and type(second) == "number" then playedSecond = second end
    if status == "play" then heardPlay = true end
    -- Le chargement peut notifier l'arret de l'ancienne piste avant audio.play.
    if audioAccepted and heardPlay and status == "stop" then
        if playedSecond >= 12 or ticks - playStarted >= 480 then
            showChoices()
        else
            phase = "audio-error"
            lv.label.set_text(body, "Lecture arrêtée trop tôt.\nNote les valeurs ci-dessous.")
            lv.label.set_text(first, "Clique : continuer sans audio")
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
            if heardPlay and ticks - playStarted >= 480 then
                showChoices()
            else
                phase = "audio-error"
                lv.label.set_text(body, "La narration ne démarre pas.\nNote les valeurs ci-dessous.")
                lv.label.set_text(first, "Clique : continuer sans audio")
            end
        end
        return
    end
    if not audioPending then return end
    loading = loading + 1
    if audio.get_status() == "stop" then
        audioPending = false
        local path = profile == 2 and "intro-stereo.mp3" or "intro.mp3"
        loadResult = audio.load(0, path, feedback)
        if loadResult == 0 then
            -- Accepter les evenements de lecture seulement apres le retour de load.
            audioAccepted, heardPlay, playStarted = true, false, ticks
            audio.play()
        else
            phase = "audio-error"
            lv.label.set_text(body, "Audio indisponible.\nLe prototype n'est pas validé.")
            lv.label.set_text(first, "Clique : continuer sans audio")
        end
    elseif loading == 1 then
        audio.stop()
    elseif loading > 200 then
        phase = "audio-error"
        lv.label.set_text(body, "Le lecteur audio ne répond pas.")
        lv.label.set_text(hint, "Bouton retour : bibliothèque.")
    end
end

function adventure.start()
    selected, phase, ticks, lastClick, loading = 1, "ready", 0, -20, 0
    profile, audioPending, audioAccepted, heardPlay = 2, false, false, false
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
    heading = text(root, "Le passage des lucioles", 8, 34, lv.font.nunito_bold_20)
    body = text(root, "Écoute le début de ton aventure...", 48, 62, lv.font.nunito_bold_16)
    first = text(root, "", 114, 26, lv.font.nunito_bold_16)
    second = text(root, "", 144, 26, lv.font.nunito_bold_16)
    hint = text(root, "Bouton retour : bibliothèque.", 183, 26, lv.font.nunito_bold_12)
    lv.obj.add_event_cb(root, key, lv.EVENT_KEY)
    lv.obj.add_event_cb(root, click, lv.EVENT_CLICKED)
    lv.group.add_obj(document, root)
    timer = lv.timer.new(tick, 25, nil)
    welcome()
end

return adventure
