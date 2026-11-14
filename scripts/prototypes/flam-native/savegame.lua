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

function savegame.write(value)
    if not progression or not progression.save then return false, "unavailable" end
    local ok, result = pcall(progression.save, slot, value)
    if not ok or result == false then return false, "write" end
    local stored, problem = savegame.read()
    if problem or not stored then return false, "readback" end
    for key, item in pairs(value) do
        if stored[key] ~= item then return false, "readback" end
    end
    return true
end

return savegame
