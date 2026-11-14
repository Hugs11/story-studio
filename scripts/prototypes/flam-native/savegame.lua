-- Seule frontiere de stockage : le firmware isole ce slot dans l'aventure.
local savegame = {}
local slot = "lucioles"

function savegame.read()
    if not progression or not progression.load then return nil, "unavailable" end
    local ok, value = pcall(progression.load, slot)
    if not ok or (value ~= nil and type(value) ~= "table") then return nil, "read" end
    if value == nil or next(value) == nil then return nil end
    return value
end

local function equal(first, second)
    if first == nil or second == nil then return first == second end
    for key, item in pairs(first) do if second[key] ~= item then return false end end
    for key, item in pairs(second) do if first[key] ~= item then return false end end
    return true
end

function savegame.write(value, previous)
    if not progression or not progression.save then return false, "unavailable" end
    -- Meme un appel en erreur peut avoir ecrit : seule la relecture permet de trancher.
    pcall(progression.save, slot, value)
    local stored, problem = savegame.read()
    if problem then return false, "uncertain" end
    if equal(stored, value) then return true end
    if equal(stored, previous) then return false, "write" end
    return false, "uncertain"
end

return savegame
