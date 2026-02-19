// Screeps World RCL6+ 完整玩家代码 (ES5 语法)
// 全局常量定义
var ROLE_HARVESTER = 'harvester';
var ROLE_UPGRADER = 'upgrader';
var ROLE_TRANSPORTER = 'transporter';
var ROLE_BUILDER = 'builder';
var ROLE_MINERAL = 'mineralHarvester';
var ROLE_ATTACKER = 'attacker';
var ROLE_DEFENDER = 'defender';
var ROLE_COLONIZER = 'colonizer';
var ROLE_HEALER = 'healer'; // 新增治疗者角色

// 主循环
module.exports.loop = function () {
    // 清理死亡creep内存
    for (var name in Memory.creeps) {
        if (!Game.creeps[name]) {
            delete Memory.creeps[name];
        }
    }

    // 处理每个房间
    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        if (room.controller && room.controller.my) {
            // 最低生存保障检查
            survivalCheck(room);
            
            // 房间基础设施管理
            manageLinks(room);
            manageTowers(room);
            manageTerminal(room);
            
            // Creep 生成与管理
            spawnCreeps(room);
            runCreeps(room);
            
            // 扩张逻辑 (优先占领W13S58)
            expandToTargetRoom(room, 'W13S58');
        }
    }
};

// 1. 最低生存保障
function survivalCheck(room) {
    var minHarvesters = 3;
    var minDefenders = 1;
    var currentHarvesters = _.filter(Game.creeps, function(creep) {
        return creep.memory.role === ROLE_HARVESTER && creep.room.name === room.name;
    });
    var currentDefenders = _.filter(Game.creeps, function(creep) {
        return creep.memory.role === ROLE_DEFENDER && creep.room.name === room.name;
    });

    // 紧急生成采集者
    if (currentHarvesters.length < minHarvesters) {
        var spawn = room.find(FIND_MY_SPAWNS)[0];
        if (spawn) {
            var newName = 'Harvester' + Game.time;
            if (spawn.spawnCreep([WORK,CARRY,MOVE,MOVE], newName, {memory: {role: ROLE_HARVESTER}}) === OK) {
                console.log('紧急生成采集者: ' + newName);
            }
        }
    }

    // 紧急生成防御者
    if (currentDefenders.length < minDefenders && room.find(FIND_HOSTILE_CREEPS).length > 0) {
        var spawn = room.find(FIND_MY_SPAWNS)[0];
        if (spawn) {
            var newName = 'Defender' + Game.time;
            if (spawn.spawnCreep([TOUGH,TOUGH,ATTACK,MOVE,MOVE], newName, {memory: {role: ROLE_DEFENDER}}) === OK) {
                console.log('紧急生成防御者: ' + newName);
            }
        }
    }
}

// 2. Link管理
function manageLinks(room) {
    var links = room.find(FIND_MY_STRUCTURES, {
        filter: function(struct) {
            return struct.structureType === STRUCTURE_LINK;
        }
    });
    
    if (links.length < 2) return;

    // 分类Link: 资源点附近、控制器附近、Spawn附近
    var sourceLinks = [], controllerLinks = [], spawnLinks = [];
    var sources = room.find(FIND_SOURCES);
    var controller = room.controller;
    var spawns = room.find(FIND_MY_SPAWNS);

    for (var i = 0; i < links.length; i++) {
        var link = links[i];
        // 资源点附近Link
        for (var j = 0; j < sources.length; j++) {
            if (link.pos.getRangeTo(sources[j]) <= 5) {
                sourceLinks.push(link);
                break;
            }
        }
        // 控制器附近Link
        if (link.pos.getRangeTo(controller) <= 3) {
            controllerLinks.push(link);
        }
        // Spawn附近Link
        if (spawns.length > 0 && link.pos.getRangeTo(spawns[0]) <= 3) {
            spawnLinks.push(link);
        }
    }

    // 资源点Link向Spawn/控制器Link传输能量
    for (var s = 0; s < sourceLinks.length; s++) {
        var sourceLink = sourceLinks[s];
        if (sourceLink.energy > 0 && sourceLink.cooldown === 0) {
            // 优先给Spawn Link
            if (spawnLinks.length > 0 && spawnLinks[0].energy < spawnLinks[0].energyCapacity) {
                sourceLink.transferEnergy(spawnLinks[0]);
            }
            // 其次给控制器Link
            else if (controllerLinks.length > 0 && controllerLinks[0].energy < controllerLinks[0].energyCapacity) {
                sourceLink.transferEnergy(controllerLinks[0]);
            }
        }
    }
}

// 3. Tower管理
function manageTowers(room) {
    var towers = room.find(FIND_MY_STRUCTURES, {
        filter: function(struct) {
            return struct.structureType === STRUCTURE_TOWER;
        }
    });

    for (var i = 0; i < towers.length; i++) {
        var tower = towers[i];
        if (tower.energy < 10) continue;

        // 优先攻击入侵者
        var hostiles = room.find(FIND_HOSTILE_CREEPS);
        if (hostiles.length > 0) {
            tower.attack(hostiles[0]);
            continue;
        }

        // 其次治疗受伤友军
        var injuredCreeps = room.find(FIND_MY_CREEPS, {
            filter: function(creep) {
                return creep.hits < creep.hitsMax;
            }
        });
        if (injuredCreeps.length > 0) {
            tower.heal(injuredCreeps[0]);
            continue;
        }

        // 最后维修建筑
        var damagedStructures = room.find(FIND_STRUCTURES, {
            filter: function(struct) {
                return struct.hits < struct.hitsMax && 
                       struct.structureType !== STRUCTURE_WALL && 
                       struct.structureType !== STRUCTURE_RAMPART;
            }
        });
        if (damagedStructures.length > 0) {
            damagedStructures.sort(function(a, b) {
                return (a.hits / a.hitsMax) - (b.hits / b.hitsMax);
            });
            tower.repair(damagedStructures[0]);
        }
    }
}

// 4. Terminal管理 (Z矿出售)
function manageTerminal(room) {
    var terminal = room.terminal;
    if (!terminal || !terminal.my) return;

    // 只处理RCL6+且有Z矿库存的情况
    if (room.controller.level < 6 || !terminal.store[RESOURCE_ZYNTHIUM]) return;

    // 保留基础库存，多余的出售
    var keepAmount = 1000;
    var sellAmount = terminal.store[RESOURCE_ZYNTHIUM] - keepAmount;
    
    if (sellAmount > 0) {
        // 获取当前市场价格
        var market = Game.market;
        var orders = market.getAllOrders({
            type: ORDER_BUY,
            resourceType: RESOURCE_ZYNTHIUM
        });
        
        if (orders.length > 0) {
            // 按价格排序，优先卖给最高价
            orders.sort(function(a, b) {
                return b.price - a.price;
            });
            
            // 执行出售
            for (var i = 0; i < orders.length; i++) {
                var order = orders[i];
                var amount = Math.min(sellAmount, order.amount);
                if (amount > 0) {
                    var result = market.deal(order.id, amount, room.name);
                    if (result === OK) {
                        console.log('出售Z矿: ' + amount + ' 单位, 价格: ' + order.price + ' 信用点');
                        sellAmount -= amount;
                        if (sellAmount <= 0) break;
                    }
                }
            }
        }
    }
}

// 5. Creep生成 (调整为4人作战小队配置)
function spawnCreeps(room) {
    var spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) return;
    var spawn = spawns[0];
    if (spawn.spawning) return;

    // Creep数量配置 (优化作战小队)
    var creepCounts = {
        [ROLE_HARVESTER]: 2,    // 保留基础采集
        [ROLE_UPGRADER]: 4,     // 减少升级者保障作战单位
        [ROLE_TRANSPORTER]: 2,  // 减少运输者保障作战单位
        [ROLE_BUILDER]: 1,      // 保留基础建造
        [ROLE_MINERAL]: 0,      // 暂停矿物采集
        [ROLE_ATTACKER]: 0,     // 停用通用攻击者
        [ROLE_DEFENDER]: 2,     // 2个近战防御者 (作战小队)
        [ROLE_COLONIZER]: 1,    // 1个占领者 (作战小队)
        [ROLE_HEALER]: 1        // 1个治疗者 (作战小队)
    };

    // 检查各角色Creep数量
    for (var role in creepCounts) {
        var count = _.filter(Game.creeps, function(creep) {
            return creep.memory.role === role && creep.room.name === room.name;
        }).length;

        if (count < creepCounts[role]) {
            // 根据角色创建不同身体部件
            var body = [];
            switch (role) {
                case ROLE_HARVESTER:
                    body = [WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,WORK,CARRY,CARRY,CARRY,CARRY,MOVE,MOVE,MOVE,MOVE];
                    break;
                case ROLE_UPGRADER:
                    body = [WORK,WORK,WORK,WORK,CARRY,CARRY,MOVE,MOVE,MOVE,MOVE];
                    break;
                case ROLE_TRANSPORTER:
                    body = [CARRY,CARRY,CARRY,MOVE,MOVE,MOVE];
                    break;
                case ROLE_BUILDER:
                    body = [WORK,CARRY,CARRY,MOVE,MOVE];
                    break;
                case ROLE_MINERAL:
                    body = [WORK,WORK,CARRY,MOVE,MOVE,WORK];
                    break;
                case ROLE_ATTACKER:
                    body = [ATTACK,ATTACK,ATTACK,MOVE,MOVE,MOVE];
                    break;
                case ROLE_DEFENDER:
                    // 强化防御者身体 (适合作战)
                    body = [TOUGH,TOUGH,ATTACK,ATTACK,MOVE,MOVE];
                    break;
                case ROLE_COLONIZER:
                    // 强化占领者 (双CLAIM保证成功占领)
                    body = [CLAIM,CLAIM,MOVE,MOVE];
                    break;
                case ROLE_HEALER:
                    // 治疗者身体配置
                    body = [HEAL,HEAL,MOVE,MOVE];
                    break;
            }

            // 生成Creep
            var newName = role + Game.time;
            var result = spawn.spawnCreep(body, newName, {memory: {role: role}});
            if (result === OK) {
                console.log('生成Creep: ' + newName + ' 角色: ' + role);
                return; // 一次只生成一个
            }
        }
    }
}

// 6. Creep运行逻辑
function runCreeps(room) {
    // 遍历所有Creep
    for (var name in Game.creeps) {
        var creep = Game.creeps[name];
        if (creep.room.name !== room.name) continue;

        switch (creep.memory.role) {
            case ROLE_HARVESTER:
                runHarvester(creep);
                break;
            case ROLE_UPGRADER:
                runUpgrader(creep);
                break;
            case ROLE_TRANSPORTER:
                runTransporter(creep);
                break;
            case ROLE_BUILDER:
                runBuilder(creep);
                break;
            case ROLE_MINERAL:
                runMineralHarvester(creep);
                break;
            case ROLE_ATTACKER:
                runAttacker(creep);
                break;
            case ROLE_DEFENDER:
                runDefender(creep);
                break;
            case ROLE_COLONIZER:
                runColonizer(creep);
                break;
            case ROLE_HEALER:
                runHealer(creep);
                break; // 新增治疗者运行逻辑
        }
    }
}

// 采集者逻辑 (双Source均衡分配，冷却时自动切换)
function runHarvester(creep) {
    var room = creep.room;
    var sources = room.find(FIND_SOURCES);
    var availableSources = [];
    
    // 筛选可采集的source
    for (var i = 0; i < sources.length; i++) {
        if (sources[i].energy > 0) {
            availableSources.push(sources[i]);
        }
    }
    
    // 如果没有可用source，等待
    if (availableSources.length === 0) {
        creep.say('⏳ 等待');
        return;
    }

    // 绑定或切换Source逻辑
    if (!creep.memory.sourceId || !Game.getObjectById(creep.memory.sourceId)) {
        // 初始分配Source
        assignSourceToCreep(creep, sources);
    } else {
        // 检查当前绑定的source是否可用
        var currentSource = Game.getObjectById(creep.memory.sourceId);
        if (!currentSource || currentSource.energy <= 0) {
            // 当前source不可用，重新分配可用的source
            assignSourceToCreep(creep, availableSources);
        }
    }

    var targetSource = Game.getObjectById(creep.memory.sourceId) || availableSources[0];

    if (creep.carry.energy < creep.carryCapacity) {
        if (creep.harvest(targetSource) === ERR_NOT_IN_RANGE) {
            creep.moveTo(targetSource, {visualizePathStyle: {stroke: '#ffaa00'}});
        }
    } else {
        // 优先找Link
        var links = room.find(FIND_MY_STRUCTURES, {
            filter: function(struct) {
                return struct.structureType === STRUCTURE_LINK && struct.energy < struct.energyCapacity;
            }
        });
        if (links.length > 0) {
            if (creep.transfer(links[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(links[0], {visualizePathStyle: {stroke: '#ffffff'}});
            }
            return;
        }

        // 其次找Container
        var containers = room.find(FIND_STRUCTURES, {
            filter: function(struct) {
                return struct.structureType === STRUCTURE_CONTAINER && struct.store[RESOURCE_ENERGY] < struct.storeCapacity;
            }
        });
        if (containers.length > 0) {
            if (creep.transfer(containers[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(containers[0], {visualizePathStyle: {stroke: '#ffffff'}});
            }
            return;
        }

        // 然后找Extension
        var extensions = room.find(FIND_MY_STRUCTURES, {
            filter: function(struct) {
                return struct.structureType === STRUCTURE_EXTENSION && struct.energy < struct.energyCapacity;
            }
        });
        if (extensions.length > 0) {
            if (creep.transfer(extensions[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(extensions[0], {visualizePathStyle: {stroke: '#ffffff'}});
            }
            return;
        }

        // 然后找Spawn
        var spawns = room.find(FIND_MY_STRUCTURES, {
            filter: function(struct) {
                return struct.structureType === STRUCTURE_SPAWN && struct.energy < struct.energyCapacity;
            }
        });
        if (spawns.length > 0) {
            if (creep.transfer(spawns[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(spawns[0], {visualizePathStyle: {stroke: '#ffffff'}});
            }
            return;
        }

        // 最后找Storage
        var storage = room.storage;
        if (storage && storage.store[RESOURCE_ENERGY] < storage.storeCapacity) {
            if (creep.transfer(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(storage, {visualizePathStyle: {stroke: '#ffffff'}});
            }
        }
    }
}

// 为Creep分配Source（均衡分配逻辑）
function assignSourceToCreep(creep, sources) {
    var sourceAssign = [];
    // 统计当前各Source的分配数量
    for (var id in Memory.creeps) {
        var c = Memory.creeps[id];
        if (c.role === ROLE_HARVESTER && c.sourceId) {
            sourceAssign.push(c.sourceId);
        }
    }

    var targetSource = null;
    if (sources.length >= 2) {
        var count0 = 0, count1 = 0;
        for (var i = 0; i < sourceAssign.length; i++) {
            if (sourceAssign[i] === sources[0].id) count0++;
            else if (sourceAssign[i] === sources[1].id) count1++;
        }
        // 分配到人数较少的source
        targetSource = count0 <= count1 ? sources[0] : sources[1];
    } else {
        targetSource = sources[0];
    }

    if (targetSource) {
        creep.memory.sourceId = targetSource.id;
        creep.say('🔄 切换到S' + (sources.indexOf(targetSource) + 1));
    }
}

// 升级者逻辑 (优先控制器Link -> Container -> Storage -> 自行采集)
function runUpgrader(creep) {
    if (creep.memory.upgrading && creep.carry.energy === 0) {
        creep.memory.upgrading = false;
        creep.say('🔄 取能');
    }
    if (!creep.memory.upgrading && creep.carry.energy === creep.carryCapacity) {
        creep.memory.upgrading = true;
        creep.say('⚡ 升级');
    }

    if (creep.memory.upgrading) {
        if (creep.upgradeController(creep.room.controller) === ERR_NOT_IN_RANGE) {
            creep.moveTo(creep.room.controller, {visualizePathStyle: {stroke: '#ffffff'}});
        }
    } else {
        // 优先控制器附近Link
        var controllerLinks = creep.room.find(FIND_MY_STRUCTURES, {
            filter: function(struct) {
                return struct.structureType === STRUCTURE_LINK && 
                       struct.pos.getRangeTo(creep.room.controller) <= 3 && 
                       struct.energy > 0;
            }
        });
        if (controllerLinks.length > 0) {
            if (creep.withdraw(controllerLinks[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(controllerLinks[0], {visualizePathStyle: {stroke: '#ffaa00'}});
            }
            return;
        }

        // 其次Container
        var containers = creep.room.find(FIND_STRUCTURES, {
            filter: function(struct) {
                return struct.structureType === STRUCTURE_CONTAINER && struct.store[RESOURCE_ENERGY] > 0;
            }
        });
        if (containers.length > 0) {
            if (creep.withdraw(containers[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(containers[0], {visualizePathStyle: {stroke: '#ffaa00'}});
            }
            return;
        }

        // 然后Storage
        var storage = creep.room.storage;
        if (storage && storage.store[RESOURCE_ENERGY] > 0) {
            if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(storage, {visualizePathStyle: {stroke: '#ffaa00'}});
            }
            return;
        }

        // 最后自行采集（冷却时自动切换）
        var sources = creep.room.find(FIND_SOURCES);
        var availableSources = [];
        for (var i = 0; i < sources.length; i++) {
            if (sources[i].energy > 0) {
                availableSources.push(sources[i]);
            }
        }
        
        if (availableSources.length === 0) {
            creep.say('⏳ 等待');
            return;
        }

        if (!creep.memory.sourceId || !Game.getObjectById(creep.memory.sourceId)) {
            assignSourceToCreep(creep, sources);
        } else {
            var currentSource = Game.getObjectById(creep.memory.sourceId);
            if (!currentSource || currentSource.energy <= 0) {
                assignSourceToCreep(creep, availableSources);
            }
        }
        
        var source = Game.getObjectById(creep.memory.sourceId) || availableSources[0];
        if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
            creep.moveTo(source, {visualizePathStyle: {stroke: '#ffaa00'}});
        }
    }
}

// 运输者逻辑 (优先保障Tower能量≥50%，再分配其他建筑)
function runTransporter(creep) {
    if (creep.memory.transporting && creep.carry.energy === 0) {
        creep.memory.transporting = false;
        creep.say('🔄 取能');
    }
    if (!creep.memory.transporting && creep.carry.energy === creep.carryCapacity) {
        creep.memory.transporting = true;
        creep.say('🚚 运输');
    }

    if (creep.memory.transporting) {
        // 优先保障Tower能量不低于50%（核心修改）
        var towers = creep.room.find(FIND_MY_STRUCTURES, {
            filter: function(struct) {
                return struct.structureType === STRUCTURE_TOWER && 
                       struct.energy < struct.energyCapacity * 0.5; // 只筛选能量低于50%的Tower
            }
        });
        if (towers.length > 0) {
            // 优先补充能量最低的Tower
            towers.sort(function(a, b) {
                return (a.energy / a.energyCapacity) - (b.energy / b.energyCapacity);
            });
            if (creep.transfer(towers[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(towers[0], {visualizePathStyle: {stroke: '#ff0000'}});
            }
            return;
        }

        // 所有Tower能量≥50%后，再按原优先级分配
        // 其次Spawn
        var spawns = creep.room.find(FIND_MY_STRUCTURES, {
            filter: function(struct) {
                return struct.structureType === STRUCTURE_SPAWN && struct.energy < struct.energyCapacity;
            }
        });
        if (spawns.length > 0) {
            if (creep.transfer(spawns[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(spawns[0], {visualizePathStyle: {stroke: '#ffffff'}});
            }
            return;
        }

        // 然后Extension
        var extensions = creep.room.find(FIND_MY_STRUCTURES, {
            filter: function(struct) {
                return struct.structureType === STRUCTURE_EXTENSION && struct.energy < struct.energyCapacity;
            }
        });
        if (extensions.length > 0) {
            if (creep.transfer(extensions[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(extensions[0], {visualizePathStyle: {stroke: '#ffffff'}});
            }
            return;
        }

        // 最后Storage
        var storage = creep.room.storage;
        if (storage && creep.carry.energy > 0) {
            if (creep.transfer(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(storage, {visualizePathStyle: {stroke: '#ffffff'}});
            }
        }
    } else {
        // 优先Spawn附近Link
        var spawns = creep.room.find(FIND_MY_SPAWNS);
        if (spawns.length > 0) {
            var spawnLink = creep.room.find(FIND_MY_STRUCTURES, {
                filter: function(struct) {
                    return struct.structureType === STRUCTURE_LINK && 
                           struct.pos.getRangeTo(spawns[0]) <= 3 && 
                           struct.energy > 0;
                }
            });
            if (spawnLink.length > 0) {
                if (creep.withdraw(spawnLink[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(spawnLink[0], {visualizePathStyle: {stroke: '#ffaa00'}});
                }
                return;
            }
        }

        // 其次Container
        var containers = creep.room.find(FIND_STRUCTURES, {
            filter: function(struct) {
                return struct.structureType === STRUCTURE_CONTAINER && struct.store[RESOURCE_ENERGY] > 0;
            }
        });
        if (containers.length > 0) {
            if (creep.withdraw(containers[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(containers[0], {visualizePathStyle: {stroke: '#ffaa00'}});
            }
            return;
        }

        // 最后Storage
        var storage = creep.room.storage;
        if (storage && storage.store[RESOURCE_ENERGY] > 0) {
            if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(storage, {visualizePathStyle: {stroke: '#ffaa00'}});
            }
        }
    }
}

// 建造维护者逻辑
function runBuilder(creep) {
    if (creep.memory.building && creep.carry.energy === 0) {
        creep.memory.building = false;
        creep.say('🔄 取能');
    }
    if (!creep.memory.building && creep.carry.energy === creep.carryCapacity) {
        creep.memory.building = true;
        creep.say('🏗 建造');
    }

    if (creep.memory.building) {
        // 优先建造新建筑
        var constructionSites = creep.room.find(FIND_CONSTRUCTION_SITES);
        if (constructionSites.length > 0) {
            if (creep.build(constructionSites[0]) === ERR_NOT_IN_RANGE) {
                creep.moveTo(constructionSites[0], {visualizePathStyle: {stroke: '#ffffff'}});
            }
            return;
        }

        // 其次维修受损建筑
        var damagedStructures = creep.room.find(FIND_STRUCTURES, {
            filter: function(struct) {
                return struct.hits < struct.hitsMax && 
                       struct.structureType !== STRUCTURE_WALL && 
                       struct.structureType !== STRUCTURE_RAMPART;
            }
        });
        if (damagedStructures.length > 0) {
            damagedStructures.sort(function(a, b) {
                return (a.hits / a.hitsMax) - (b.hits / b.hitsMax);
            });
            if (creep.repair(damagedStructures[0]) === ERR_NOT_IN_RANGE) {
                creep.moveTo(damagedStructures[0], {visualizePathStyle: {stroke: '#ffffff'}});
            }
        }
    } else {
        // 取能逻辑 (同运输者)
        var spawns = creep.room.find(FIND_MY_SPAWNS);
        if (spawns.length > 0) {
            var spawnLink = creep.room.find(FIND_MY_STRUCTURES, {
                filter: function(struct) {
                    return struct.structureType === STRUCTURE_LINK && 
                           struct.pos.getRangeTo(spawns[0]) <= 3 && 
                           struct.energy > 0;
                }
            });
            if (spawnLink.length > 0) {
                if (creep.withdraw(spawnLink[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(spawnLink[0], {visualizePathStyle: {stroke: '#ffaa00'}});
                }
                return;
            }
        }

        var containers = creep.room.find(FIND_STRUCTURES, {
            filter: function(struct) {
                return struct.structureType === STRUCTURE_CONTAINER && struct.store[RESOURCE_ENERGY] > 0;
            }
        });
        if (containers.length > 0) {
            if (creep.withdraw(containers[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(containers[0], {visualizePathStyle: {stroke: '#ffaa00'}});
            }
            return;
        }

        var storage = creep.room.storage;
        if (storage && storage.store[RESOURCE_ENERGY] > 0) {
            if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(storage, {visualizePathStyle: {stroke: '#ffaa00'}});
            }
            return;
        }

        // 采集时冷却自动切换Source
        var sources = creep.room.find(FIND_SOURCES);
        var availableSources = [];
        for (var i = 0; i < sources.length; i++) {
            if (sources[i].energy > 0) {
                availableSources.push(sources[i]);
            }
        }
        
        if (availableSources.length === 0) {
            creep.say('⏳ 等待');
            return;
        }

        if (!creep.memory.sourceId || !Game.getObjectById(creep.memory.sourceId)) {
            assignSourceToCreep(creep, sources);
        } else {
            var currentSource = Game.getObjectById(creep.memory.sourceId);
            if (!currentSource || currentSource.energy <= 0) {
                assignSourceToCreep(creep, availableSources);
            }
        }
        
        var source = Game.getObjectById(creep.memory.sourceId) || availableSources[0];
        if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
            creep.moveTo(source, {visualizePathStyle: {stroke: '#ffaa00'}});
        }
    }
}

// 稀有矿采集者逻辑
function runMineralHarvester(creep) {
    if (creep.carry.energy < creep.carryCapacity) {
        var minerals = creep.room.find(FIND_MINERALS);
        if (minerals.length > 0) {
            var mineral = minerals[0];
            if (creep.harvest(mineral) === ERR_NOT_IN_RANGE) {
                creep.moveTo(mineral, {visualizePathStyle: {stroke: '#ff00ff'}});
            }
        }
    } else {
        var terminal = creep.room.terminal;
        if (terminal && !terminal.full) {
            var resourceType = Object.keys(creep.carry)[0];
            if (creep.transfer(terminal, resourceType) === ERR_NOT_IN_RANGE) {
                creep.moveTo(terminal, {visualizePathStyle: {stroke: '#ff00ff'}});
            }
        } else {
            var storage = creep.room.storage;
            if (storage && !storage.full) {
                var resourceType = Object.keys(creep.carry)[0];
                if (creep.transfer(storage, resourceType) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(storage, {visualizePathStyle: {stroke: '#ff00ff'}});
                }
            }
        }
    }
}

// 攻击者逻辑
function runAttacker(creep) {
    var targetRoom = creep.memory.targetRoom || creep.room.name;
    if (creep.room.name !== targetRoom) {
        creep.moveTo(new RoomPosition(25, 25, targetRoom), {visualizePathStyle: {stroke: '#ff0000'}});
        return;
    }

    var hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
    if (hostiles.length > 0) {
        if (creep.attack(hostiles[0]) === ERR_NOT_IN_RANGE) {
            creep.moveTo(hostiles[0], {visualizePathStyle: {stroke: '#ff0000'}});
        }
    } else {
        var hostileStructures = creep.room.find(FIND_HOSTILE_STRUCTURES, {
            filter: function(struct) {
                return struct.structureType !== STRUCTURE_CONTROLLER;
            }
        });
        if (hostileStructures.length > 0) {
            if (creep.attack(hostileStructures[0]) === ERR_NOT_IN_RANGE) {
                creep.moveTo(hostileStructures[0], {visualizePathStyle: {stroke: '#ff0000'}});
            }
        } else {
            creep.moveTo(creep.room.controller, {visualizePathStyle: {stroke: '#ff0000'}});
        }
    }
}

// 防御者逻辑 (修改为优先攻击W13S58的敌人)
function runDefender(creep) {
    var targetRoom = 'W13S58';
    var isInTargetRoom = (creep.room.name === targetRoom);

    // 强制离开出口Tile（最关键修复）
    if (creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49) {
        // 往房间中心走一步，离开出口
        creep.moveTo(25, 25, {
            visualizePathStyle: { stroke: '#ff0000' },
            ignoreCreeps: true,
            reusePath: 20
        });
        creep.say('🚪 离开出口');
        return;
    }

    // 不在目标房间 → 前往目标房间
    if (!isInTargetRoom) {
        creep.moveTo(new RoomPosition(25, 25, targetRoom), {
            visualizePathStyle: { stroke: '#ff0000' },
            ignoreCreeps: true,
            reusePath: 50, // 路径缓存50tick，减少重复寻路
            maxRooms: 2    // 最多跨2个房间
        });
        creep.say('⚔️ 进军');
        return;
    }

    // 已在目标房间 → 正常作战
    var hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
    if (hostiles.length > 0) {
        var target = creep.pos.findClosestByRange(hostiles);
        if (creep.attack(target) === ERR_NOT_IN_RANGE) {
            creep.moveTo(target, { visualizePathStyle: { stroke: '#ff0000' }, ignoreCreeps: true });
        }
        creep.say('⚔️ 攻击');
    } else {
        // 护卫占领者
        var colonizer = creep.pos.findClosestByRange(FIND_MY_CREEPS, {
            filter: c => c.memory.role === ROLE_COLONIZER
        });
        if (colonizer) {
            creep.moveTo(colonizer, { visualizePathStyle: { stroke: '#00ff00' }, ignoreCreeps: true });
            creep.say('🛡️ 护卫');
        } else {
            creep.moveTo(creep.room.controller, { visualizePathStyle: { stroke: '#00ff00' }, ignoreCreeps: true });
        }
    }
}

// 治疗者逻辑 (新增，专门支援W13S58作战)
function runHealer(creep) {
    var targetRoom = 'W13S58';
    var isInTargetRoom = (creep.room.name === targetRoom);

    // 强制离开出口Tile
    if (creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49) {
        creep.moveTo(25, 25, {
            visualizePathStyle: { stroke: '#00ffff' },
            ignoreCreeps: true,
            reusePath: 20
        });
        creep.say('🚪 离开出口');
        return;
    }

    // 不在目标房间 → 前往目标房间
    if (!isInTargetRoom) {
        creep.moveTo(new RoomPosition(25, 25, targetRoom), {
            visualizePathStyle: { stroke: '#00ffff' },
            ignoreCreeps: true,
            reusePath: 50,
            maxRooms: 2
        });
        creep.say('🩹 支援');
        return;
    }

    // 已在目标房间 → 正常治疗
    var hurtCreep = creep.pos.findClosestByRange(FIND_MY_CREEPS, {
        filter: c => c.hits < c.hitsMax
    });
    if (hurtCreep) {
        if (creep.heal(hurtCreep) === ERR_NOT_IN_RANGE) {
            creep.moveTo(hurtCreep, { visualizePathStyle: { stroke: '#00ffff' }, ignoreCreeps: true });
        }
        creep.say('🩹 治疗');
    } else {
        var defender = creep.pos.findClosestByRange(FIND_MY_CREEPS, {
            filter: c => c.memory.role === ROLE_DEFENDER
        });
        if (defender) {
            creep.moveTo(defender, { visualizePathStyle: { stroke: '#00ffff' }, ignoreCreeps: true });
            creep.say('🤝 跟随');
        } else {
            creep.moveTo(creep.room.controller, { visualizePathStyle: { stroke: '#00ffff' }, ignoreCreeps: true });
        }
    }
}

// 殖民者逻辑 (修改为固定占领W13S58)
function runColonizer(creep) {
    var targetRoom = 'W13S58';
    var isInTargetRoom = (creep.room.name === targetRoom);

    // 强制离开出口Tile
    if (creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49) {
        creep.moveTo(25, 25, {
            visualizePathStyle: { stroke: '#ffff00' },
            ignoreCreeps: true,
            reusePath: 20
        });
        creep.say('🚪 离开出口');
        return;
    }

    // 不在目标房间 → 前往目标房间
    if (!isInTargetRoom) {
        creep.moveTo(new RoomPosition(25, 25, targetRoom), {
            visualizePathStyle: { stroke: '#ffff00' },
            ignoreCreeps: true,
            reusePath: 50,
            maxRooms: 2
        });
        creep.say('🏴 占领');
        return;
    }

    // 已在目标房间 → 占领/升级控制器
    var controller = creep.room.controller;
    if (!controller) return;

    if (controller.owner && !controller.owner.my) {
        if (creep.reserveController(controller) === ERR_NOT_IN_RANGE) {
            creep.moveTo(controller, { visualizePathStyle: { stroke: '#ffff00' }, ignoreCreeps: true });
        }
    } else if (!controller.my) {
        if (creep.claimController(controller) === ERR_NOT_IN_RANGE) {
            creep.moveTo(controller, { visualizePathStyle: { stroke: '#ffff00' }, ignoreCreeps: true });
        } else if (creep.claimController(controller) === ERR_GCL_NOT_ENOUGH) {
            creep.reserveController(controller);
        }
    } else {
        if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
            creep.moveTo(controller, { visualizePathStyle: { stroke: '#ffff00' }, ignoreCreeps: true });
        }
        creep.say('🔼 升级');
    }
}

// 7. 扩张逻辑 (修改为优先占领指定目标房间)
function expandToTargetRoom(mainRoom, targetRoomName) {
    // 检查目标房间是否已被占领
    var targetRoom = Game.rooms[targetRoomName];
    if (targetRoom && targetRoom.controller && targetRoom.controller.my) {
        return; // 已占领，无需行动
    }

    // 检查是否已有殖民者在前往目标房间
    var colonizers = _.filter(Game.creeps, function(creep) {
        return creep.memory.role === ROLE_COLONIZER && 
               (creep.memory.targetRoom === targetRoomName || creep.room.name === targetRoomName);
    });
    if (colonizers.length > 0) return;

    // 分配殖民者前往目标房间
    var colonizer = _.filter(Game.creeps, function(creep) {
        return creep.memory.role === ROLE_COLONIZER && !creep.memory.targetRoom;
    })[0];
    
    if (colonizer) {
        colonizer.memory.targetRoom = targetRoomName;
        console.log('派遣殖民者前往目标房间: ' + targetRoomName);
    }
    
    // 1. 查GCL等级和进度
		console.log('当前GCL等级:', Game.gcl.level);
		console.log('GCL当前点数/升级所需:', Game.gcl.progress + '/' + Game.gcl.progressTotal);

		// 2. 查已占领的房间数（my房间数）
		var ownedRooms = Object.values(Game.rooms).filter(room => room.controller && room.controller.my);
		console.log('已占领房间数:', ownedRooms.length);

		// 3. 直接判断是否能占领新房间
		var canClaimNewRoom = ownedRooms.length < Game.gcl.level;
		console.log('是否能占领新房间:', canClaimNewRoom ? '✅ 可以' : '❌ 不可以（GCL不足）');
}