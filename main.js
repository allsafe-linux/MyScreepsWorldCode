// ==================== 配置常量（统一管理，便于后续扩展） ====================
const CONFIG = {
    SPAWN_NAME: "Allsafe1",
    ROOM_NAME: "E33N36",
    // Creep身体配置（优化部件比例，提升工作/移动效率）
    CREEP_BODIES: {
        HARVESTER: [WORK, WORK, CARRY, CARRY, MOVE, MOVE], // 2WORK+2CARRY+1MOVE：采集快、移动稳，适配双资源点
        CARRIER: [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE], // 4CARRY+2MOVE：优化运输比，提升单次运量
        UPGRADER: [WORK, WORK, CARRY, CARRY, MOVE, MOVE], // 2WORK+2CARRY+2MOVE：平衡升级与往返效率
        BUILDER_REPAIRER: [WORK, WORK, CARRY, CARRY, MOVE, MOVE], // 2WORK+2CARRY+2MOVE：建造/修复均衡
        ATTACK_DEFENDER: [ATTACK, ATTACK, TOUGH, TOUGH, MOVE, MOVE], // 2ATTACK+2TOUGH+2MOVE：抗伤+输出均衡
        RANGED_DEFENDER: [RANGED_ATTACK, RANGED_ATTACK, TOUGH, TOUGH, MOVE, MOVE] // 2远程+2抗伤+2移动：提升生存能力
    },
    CREEP_ROLES: {
        HARVESTER: "harvester",
        CARRIER: "carrier",
        UPGRADER: "upgrader",
        BUILDER: "builder",
        DEFENDER: "defender",
        RANGED_DEFENDER: "ranged_defender"
    },
    MIN_CREEP_COUNT: {
        harvester: 2,
        carrier: 1,
        upgrader: 2,
        builder: 2,
        defender: 0,
        ranged_defender: 0
    },
    // 优化配置：减少日志频率，降低CPU消耗
    LOG_INTERVAL: 20,
    SOURCE_NEAR_RANGE: 5,
    // 能量优先级优化（取能优先容器，送能优先核心建筑）
    ENERGY_STRUCTURE_PRIORITY: {
        TRANSFER: [STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER, STRUCTURE_CONTAINER],
        WITHDRAW: [STRUCTURE_CONTAINER, STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER]
    },
    // 公共移动配置（提取冗余，统一复用，提升路径计算效率）
    MOVE_CONFIG: {
        reusePath: 20, // 延长路径复用时间，减少重复计算
        ignoreCreeps: true,
        maxRooms: 1,
        visualizePathStyle: { stroke: "#ffffff", opacity: 0.5, lineStyle: "dashed" }
    }
};

// ==================== 工具函数（优化性能，补充容错，提取冗余） ====================
const utils = {
    // 1. 清理死亡Creep内存（优化遍历，减少CPU消耗）
    cleanDeadCreepMemory: function() {
        for (const creepName in Memory.creeps) {
            if (!Game.creeps[creepName]) {
                this.logWithInterval(`[清理内存] 移除死亡Creep：${creepName}`);
                delete Memory.creeps[creepName];
            }
        }
    },

    // 2. 计算Creep身体总成本（兼容空数组容错）
    calculateCreepCost: function(bodyParts) {
        if (!Array.isArray(bodyParts) || bodyParts.length === 0) return 0;
        return bodyParts.reduce((totalCost, part) => totalCost + (BODYPART_COST[part] || 0), 0);
    },

    // 3. 统计指定角色存活Creep数量（优化筛选逻辑，替换?.为&&）
    countCreepsByRole: function(role) {
        if (!role) return 0;
        return Object.values(Game.creeps).filter(creep => creep.memory && creep.memory.role === role).length;
    },

    // 4. 频率控制日志（避免高频打印，降低CPU消耗）
    logWithInterval: function(message) {
        if (Game.time % CONFIG.LOG_INTERVAL === 0 && message) {
            console.log(message);
        }
    },

    // 5. 统计指定资源点的采集者数量（精准筛选，避免冗余，替换?.为&&）
    countHarvestersOnSource: function(sourceId) {
        if (!sourceId) return 0;
        return Object.values(Game.creeps).filter(creep => {
            return creep.memory && creep.memory.role === CONFIG.CREEP_ROLES.HARVESTER && creep.memory && creep.memory.harvestSourceId === sourceId;
        }).length;
    },

    // 6. 判断指定资源点是否正在被采集（复用已有逻辑，提升一致性）
    isSourceBeingHarvested: function(source) {
        if (!source || !source.id) return false;
        return this.countHarvestersOnSource(source.id) > 0;
    },

    // 7. 为Harvester分配专属资源点（优化双资源点分配，减少路径计算，替换?.为&&）
    getOptimalSource: function(creep) {
        if (!creep) return null;

        // 步骤1：获取房间所有资源点（缓存查询结果，减少find调用，替换?.为&&）
        const sources = creep.room && creep.room.find(FIND_SOURCES) || [];
        if (sources.length === 0) return null;

        // 步骤2：优先使用记忆中的专属资源点（存在则直接返回，替换?.为&&）
        if (creep.memory && creep.memory.harvestSourceId) {
            const memorizedSource = Game.getObjectById(creep.memory.harvestSourceId);
            if (memorizedSource) {
                return memorizedSource;
            } else {
                // 清理无效内存，避免脏数据
                delete creep.memory.harvestSourceId;
            }
        }

        // 步骤3：无记忆资源点，分配采集者最少的资源点（双资源点均衡分配）
        let assignedSource = null;
        let minHarvesters = Infinity;

        for (const source of sources) {
            const currentHarvesterCount = this.countHarvestersOnSource(source.id);
            if (currentHarvesterCount < minHarvesters) {
                minHarvesters = currentHarvesterCount;
                assignedSource = source;
            }
        }

        // 步骤4：写入内存，标记专属资源点（后续不再重新分配）
        if (assignedSource) {
            creep.memory.harvestSourceId = assignedSource.id;
        }

        // 替换?.为&&，避免语法报错
        return creep.pos && creep.pos.findClosestByPath([assignedSource]) || assignedSource;
    },

    // 8. 判断Creep是否在资源点附近（优化容错，避免空数组报错，替换?.为&&）
    isNearSource: function(creep) {
        if (!creep) return false;
        const sources = creep.room && creep.room.find(FIND_SOURCES) || [];
        if (sources.length === 0) return false;
        return sources.some(source => creep.pos && creep.pos.getRangeTo(source) <= CONFIG.SOURCE_NEAR_RANGE);
    },

    // 9. 获取最优能量运送目标（优化筛选逻辑，补充兜底容错，替换?.为&&）
    getOptimalTransferTarget: function(creep) {
        if (!creep) return null;

        const transferPriorities = CONFIG.ENERGY_STRUCTURE_PRIORITY.TRANSFER;
        for (const structureType of transferPriorities) {
            // 替换?.为&&
            const structures = creep.room && creep.room.find(FIND_MY_STRUCTURES, {
                filter: s => {
                    return s.structureType === structureType && s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
                }
            }) || [];

            if (structures.length > 0) {
                // 替换?.为&&
                return creep.pos && creep.pos.findClosestByPath(structures, CONFIG.MOVE_CONFIG) || structures[0];
            }
        }

        // 兜底：返回Spawn（若存在）
        return Game.spawns[CONFIG.SPAWN_NAME] || null;
    },

    // 10. 获取最优能量取能目标（优化筛选逻辑，优先容器取能，替换?.为&&）
    getOptimalWithdrawTarget: function(creep) {
        if (!creep) return null;

        const withdrawPriorities = CONFIG.ENERGY_STRUCTURE_PRIORITY.WITHDRAW;
        for (const structureType of withdrawPriorities) {
            // 替换?.为&&
            const structures = creep.room && creep.room.find(FIND_MY_STRUCTURES, {
                filter: s => {
                    return s.structureType === structureType && s.store && s.store[RESOURCE_ENERGY] > 0;
                }
            }) || [];

            if (structures.length > 0) {
                // 替换?.为&&
                return creep.pos && creep.pos.findClosestByPath(structures, CONFIG.MOVE_CONFIG) || structures[0];
            }
        }

        return null;
    },

    // 11. 根据角色匹配对应身体类型（优化容错，兜底更合理）
    getCreepBodyByRole: function(role) {
        if (!role) return CONFIG.CREEP_BODIES.HARVESTER;

        switch (role) {
            case CONFIG.CREEP_ROLES.HARVESTER:
                return CONFIG.CREEP_BODIES.HARVESTER;
            case CONFIG.CREEP_ROLES.CARRIER:
                return CONFIG.CREEP_BODIES.CARRIER;
            case CONFIG.CREEP_ROLES.UPGRADER:
                return CONFIG.CREEP_BODIES.UPGRADER;
            case CONFIG.CREEP_ROLES.BUILDER:
                return CONFIG.CREEP_BODIES.BUILDER_REPAIRER;
            case CONFIG.CREEP_ROLES.DEFENDER:
                return CONFIG.CREEP_BODIES.ATTACK_DEFENDER;
            case CONFIG.CREEP_ROLES.RANGED_DEFENDER:
                return CONFIG.CREEP_BODIES.RANGED_DEFENDER;
            default:
                return CONFIG.CREEP_BODIES.HARVESTER;
        }
    },

    // 12. 通用移动方法（提取冗余，统一配置，提升可维护性）
    moveToTarget: function(creep, target, pathColor = "#ffffff") {
        if (!creep || !target) return;
        const moveConfig = { ...CONFIG.MOVE_CONFIG };
        moveConfig.visualizePathStyle.stroke = pathColor;
        creep.moveTo(target, moveConfig);
    }
};

// ==================== Creep核心行为（优化逻辑，减少冗余，提升健壮性） ====================
// ------------- 采集型（Harvester）：双资源点专属分配，其余逻辑不变 -------------
function runHarvester(creep) {
    if (!creep) return;

    // 初始化任务状态
    if (!creep.memory.taskStatus) {
        creep.memory.taskStatus = "collecting";
    }

    // 状态1：采集能量（双资源点专属分配）
    if (creep.memory.taskStatus === "collecting") {
        const targetSource = utils.getOptimalSource(creep);
        if (!targetSource) {
            utils.logWithInterval(`[${creep.name}] 未找到可用能量矿，无法采集`);
            return;
        }

        // 执行采集操作
        const harvestResult = creep.harvest(targetSource);
        switch (harvestResult) {
            case OK:
                utils.logWithInterval(`[${creep.name}] 正在采集资源点${targetSource.id}，当前能量：${creep.store[RESOURCE_ENERGY]}/${creep.store.getCapacity(RESOURCE_ENERGY)}`);
                break;
            case ERR_NOT_IN_RANGE:
                utils.moveToTarget(creep, targetSource, "#ffff00");
                utils.logWithInterval(`[${creep.name}] 移动到资源点${targetSource.id}，准备采集`);
                break;
            default:
                utils.logWithInterval(`[${creep.name}] 采集失败，错误码：${harvestResult}`);
                break;
        }

        // 采集装满，切换为运输状态
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.taskStatus = "transferring";
            utils.logWithInterval(`[${creep.name}] 能量装满，切换为运输状态`);
        }
    }

    // 状态2：运送能量（保留原有优先级，优化移动逻辑）
    else if (creep.memory.taskStatus === "transferring") {
        const transferTarget = utils.getOptimalTransferTarget(creep);
        if (!transferTarget) {
            utils.logWithInterval(`[${creep.name}] 未找到可用运送目标，无法运输`);
            return;
        }

        // 执行运送操作
        const transferResult = creep.transfer(transferTarget, RESOURCE_ENERGY);
        switch (transferResult) {
            case OK:
                utils.logWithInterval(`[${creep.name}] 正在向${transferTarget.structureType}运送能量，剩余能量：${creep.store[RESOURCE_ENERGY]}/${creep.store.getCapacity(RESOURCE_ENERGY)}`);
                break;
            case ERR_NOT_IN_RANGE:
                utils.moveToTarget(creep, transferTarget, "#00ffff");
                utils.logWithInterval(`[${creep.name}] 移动到${transferTarget.structureType}，准备运输能量`);
                break;
            default:
                utils.logWithInterval(`[${creep.name}] 运送失败，错误码：${transferResult}`);
                break;
        }

        // 运送完成，切换为采集状态
        if (creep.store[RESOURCE_ENERGY] <= 0) {
            creep.memory.taskStatus = "collecting";
            utils.logWithInterval(`[${creep.name}] 能量运输完成，切换为采集状态`);
        }
    }
}

// ------------- 运输型（Carrier）：优先容器取能，优化运输效率 -------------
function runCarrier(creep) {
    if (!creep) return;

    // 初始化任务状态
    if (!creep.memory.taskStatus) {
        creep.memory.taskStatus = "withdrawing";
    }

    // 状态1：从储能设施取能
    if (creep.memory.taskStatus === "withdrawing") {
        const withdrawTarget = utils.getOptimalWithdrawTarget(creep);
        if (!withdrawTarget) {
            utils.logWithInterval(`[${creep.name}] 无可用储能设施，无法取能`);
            return;
        }

        // 执行取能操作
        const withdrawResult = creep.withdraw(withdrawTarget, RESOURCE_ENERGY);
        switch (withdrawResult) {
            case OK:
                utils.logWithInterval(`[${creep.name}] 正在从${withdrawTarget.structureType}取能，当前能量：${creep.store[RESOURCE_ENERGY]}/${creep.store.getCapacity(RESOURCE_ENERGY)}`);
                break;
            case ERR_NOT_IN_RANGE:
                utils.moveToTarget(creep, withdrawTarget, "#ffcc00");
                utils.logWithInterval(`[${creep.name}] 移动到${withdrawTarget.structureType}，准备取能`);
                break;
            case ERR_NOT_ENOUGH_ENERGY:
                utils.logWithInterval(`[${creep.name}] ${withdrawTarget.structureType}能量耗尽，等待补充`);
                return;
            default:
                utils.logWithInterval(`[${creep.name}] 取能失败，错误码：${withdrawResult}`);
                break;
        }

        // 取能装满，切换为运输状态
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.taskStatus = "transferring";
            utils.logWithInterval(`[${creep.name}] 取能装满，切换为运输状态`);
        }
    }

    // 状态2：向缺能设施运送能量
    else if (creep.memory.taskStatus === "transferring") {
        const transferTarget = utils.getOptimalTransferTarget(creep);
        if (!transferTarget) {
            utils.logWithInterval(`[${creep.name}] 未找到可用运送目标，无法运输`);
            return;
        }

        // 执行运送操作
        const transferResult = creep.transfer(transferTarget, RESOURCE_ENERGY);
        switch (transferResult) {
            case OK:
                utils.logWithInterval(`[${creep.name}] 正在向${transferTarget.structureType}运送能量，剩余能量：${creep.store[RESOURCE_ENERGY]}/${creep.store.getCapacity(RESOURCE_ENERGY)}`);
                break;
            case ERR_NOT_IN_RANGE:
                utils.moveToTarget(creep, transferTarget, "#00ccff");
                utils.logWithInterval(`[${creep.name}] 移动到${transferTarget.structureType}，准备运输能量`);
                break;
            default:
                utils.logWithInterval(`[${creep.name}] 运送失败，错误码：${transferResult}`);
                break;
        }

        // 运送完成，切换为取能状态
        if (creep.store[RESOURCE_ENERGY] <= 0) {
            creep.memory.taskStatus = "withdrawing";
            utils.logWithInterval(`[${creep.name}] 能量运输完成，切换为取能状态`);
        }
    }
}

// ------------- 升级型（Upgrader）：优化取能逻辑，稳定升级控制器 -------------
function runUpgrader(creep) {
    if (!creep) return;

    // 初始化任务状态与标记
    if (!creep.memory.taskStatus) {
        creep.memory.taskStatus = "collecting";
    }
    if (creep.memory.hasJudgedEnergySource === undefined) {
        creep.memory.hasJudgedEnergySource = false;
    }

    // 能量耗尽，判断取能/采集策略
    if (creep.store[RESOURCE_ENERGY] <= 0 && !creep.memory.hasJudgedEnergySource) {
        const isNearSource = utils.isNearSource(creep);
        const withdrawTarget = utils.getOptimalWithdrawTarget(creep);
        const optimalSource = utils.getOptimalSource(creep);

        // 优先从储能设施取能（避免与Harvester争抢资源点）
        if (isNearSource && withdrawTarget && (optimalSource && utils.isSourceBeingHarvested(optimalSource))) {
            creep.memory.taskStatus = "withdrawing";
            utils.logWithInterval(`[${creep.name}] 有可用储能设施，切换为取能状态`);
        } else {
            creep.memory.taskStatus = "collecting";
            creep.memory.targetSourceId = optimalSource ? optimalSource.id : null;
            utils.logWithInterval(`[${creep.name}] 无可用储能设施，切换为资源点采集状态`);
        }
        creep.memory.hasJudgedEnergySource = true;
    }

    // 状态1：从储能设施取能
    if (creep.memory.taskStatus === "withdrawing") {
        const withdrawTarget = utils.getOptimalWithdrawTarget(creep);
        if (!withdrawTarget) {
            utils.logWithInterval(`[${creep.name}] 无可用储能设施，切换为资源点采集`);
            creep.memory.taskStatus = "collecting";
            creep.memory.hasJudgedEnergySource = false;
            return;
        }

        // 执行取能操作
        const withdrawResult = creep.withdraw(withdrawTarget, RESOURCE_ENERGY);
        switch (withdrawResult) {
            case OK:
                utils.logWithInterval(`[${creep.name}] 正在从${withdrawTarget.structureType}取能，当前能量：${creep.store[RESOURCE_ENERGY]}/${creep.store.getCapacity(RESOURCE_ENERGY)}`);
                break;
            case ERR_NOT_IN_RANGE:
                utils.moveToTarget(creep, withdrawTarget, "#ff9900");
                utils.logWithInterval(`[${creep.name}] 移动到${withdrawTarget.structureType}，准备取能`);
                break;
            case ERR_NOT_ENOUGH_ENERGY:
                utils.logWithInterval(`[${creep.name}] ${withdrawTarget.structureType}能量耗尽，切换为资源点采集`);
                creep.memory.taskStatus = "collecting";
                creep.memory.hasJudgedEnergySource = false;
                return;
            default:
                utils.logWithInterval(`[${creep.name}] 取能失败，错误码：${withdrawResult}`);
                break;
        }

        // 取能装满，切换为升级状态
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.taskStatus = "upgrading";
            creep.memory.hasJudgedEnergySource = false;
            utils.logWithInterval(`[${creep.name}] 取能装满，切换为升级状态`);
        }
    }

    // 状态2：从资源点采集能量
    else if (creep.memory.taskStatus === "collecting") {
        const targetSource = creep.memory.targetSourceId 
            ? Game.getObjectById(creep.memory.targetSourceId) 
            : utils.getOptimalSource(creep);

        if (!targetSource) {
            utils.logWithInterval(`[${creep.name}] 未找到可用资源点，无法采集`);
            creep.memory.hasJudgedEnergySource = false;
            return;
        }

        // 执行采集操作
        const harvestResult = creep.harvest(targetSource);
        switch (harvestResult) {
            case OK:
                utils.logWithInterval(`[${creep.name}] 正在采集资源点能量，当前能量：${creep.store[RESOURCE_ENERGY]}/${creep.store.getCapacity(RESOURCE_ENERGY)}`);
                break;
            case ERR_NOT_IN_RANGE:
                utils.moveToTarget(creep, targetSource, "#ffff00");
                utils.logWithInterval(`[${creep.name}] 移动到分配的资源点，准备采集`);
                break;
            default:
                utils.logWithInterval(`[${creep.name}] 采集失败，错误码：${harvestResult}`);
                break;
        }

        // 采集装满，切换为升级状态
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.taskStatus = "upgrading";
            creep.memory.hasJudgedEnergySource = false;
            utils.logWithInterval(`[${creep.name}] 采集装满，切换为升级状态`);
        }
    }

    // 状态3：升级房间控制器
    else if (creep.memory.taskStatus === "upgrading") {
        const controller = creep.room.controller;
        if (!controller) {
            utils.logWithInterval(`[${creep.name}] 错误：未找到房间控制器`);
            return;
        }
        if (!controller.my) {
            utils.logWithInterval(`[${creep.name}] 错误：控制器未被占领，无法升级`);
            return;
        }

        // 执行升级操作
        const upgradeResult = creep.upgradeController(controller);
        switch (upgradeResult) {
            case OK:
                utils.logWithInterval(`[${creep.name}] 正在升级控制器（等级${controller.level}），剩余能量：${creep.store[RESOURCE_ENERGY]}/${creep.store.getCapacity(RESOURCE_ENERGY)}`);
                break;
            case ERR_NOT_IN_RANGE:
                utils.moveToTarget(creep, controller, "#ffffff");
                utils.logWithInterval(`[${creep.name}] 移动到控制器，准备升级`);
                break;
            default:
                utils.logWithInterval(`[${creep.name}] 升级失败，错误码：${upgradeResult}`);
                break;
        }

        // 升级完成，等待下次策略判断
        if (creep.store[RESOURCE_ENERGY] <= 0) {
            utils.logWithInterval(`[${creep.name}] 升级能量耗尽，等待下次能源获取判断`);
        }
    }
}

// ------------- 建造修复型（Builder）：优化修复逻辑，优先低血量结构 -------------
function runBuilder(creep) {
    if (!creep) return;

    // 初始化任务状态与标记
    if (!creep.memory.taskStatus) {
        creep.memory.taskStatus = "collecting";
    }
    if (creep.memory.hasJudgedEnergySource === undefined) {
        creep.memory.hasJudgedEnergySource = false;
    }

    // 能量耗尽，判断取能/采集策略
    if (creep.store[RESOURCE_ENERGY] <= 0 && !creep.memory.hasJudgedEnergySource) {
        const isNearSource = utils.isNearSource(creep);
        const withdrawTarget = utils.getOptimalWithdrawTarget(creep);
        const optimalSource = utils.getOptimalSource(creep);

        // 优先从储能设施取能（避免与Harvester争抢资源点）
        if (isNearSource && withdrawTarget && (optimalSource && utils.isSourceBeingHarvested(optimalSource))) {
            creep.memory.taskStatus = "withdrawing";
            utils.logWithInterval(`[${creep.name}] 有可用储能设施，切换为取能状态`);
        } else {
            creep.memory.taskStatus = "collecting";
            creep.memory.targetSourceId = optimalSource ? optimalSource.id : null;
            utils.logWithInterval(`[${creep.name}] 无可用储能设施，切换为资源点采集状态`);
        }
        creep.memory.hasJudgedEnergySource = true;
    }

    // 状态1：从储能设施取能
    if (creep.memory.taskStatus === "withdrawing") {
        const withdrawTarget = utils.getOptimalWithdrawTarget(creep);
        if (!withdrawTarget) {
            utils.logWithInterval(`[${creep.name}] 无可用储能设施，切换为资源点采集`);
            creep.memory.taskStatus = "collecting";
            creep.memory.hasJudgedEnergySource = false;
            return;
        }

        // 执行取能操作
        const withdrawResult = creep.withdraw(withdrawTarget, RESOURCE_ENERGY);
        switch (withdrawResult) {
            case OK:
                utils.logWithInterval(`[${creep.name}] 正在从${withdrawTarget.structureType}取能，当前能量：${creep.store[RESOURCE_ENERGY]}/${creep.store.getCapacity(RESOURCE_ENERGY)}`);
                break;
            case ERR_NOT_IN_RANGE:
                utils.moveToTarget(creep, withdrawTarget, "#ff9900");
                utils.logWithInterval(`[${creep.name}] 移动到${withdrawTarget.structureType}，准备取能`);
                break;
            case ERR_NOT_ENOUGH_ENERGY:
                utils.logWithInterval(`[${creep.name}] ${withdrawTarget.structureType}能量耗尽，切换为资源点采集`);
                creep.memory.taskStatus = "collecting";
                creep.memory.hasJudgedEnergySource = false;
                return;
            default:
                utils.logWithInterval(`[${creep.name}] 取能失败，错误码：${withdrawResult}`);
                break;
        }

        // 取能装满，切换为建造状态
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.taskStatus = "building";
            creep.memory.hasJudgedEnergySource = false;
            utils.logWithInterval(`[${creep.name}] 取能装满，切换为建造状态`);
        }
    }

    // 状态2：从资源点采集能量
    else if (creep.memory.taskStatus === "collecting") {
        const targetSource = creep.memory.targetSourceId 
            ? Game.getObjectById(creep.memory.targetSourceId) 
            : utils.getOptimalSource(creep);

        if (!targetSource) {
            utils.logWithInterval(`[${creep.name}] 未找到可用资源点，无法采集`);
            creep.memory.hasJudgedEnergySource = false;
            return;
        }

        // 执行采集操作
        const harvestResult = creep.harvest(targetSource);
        switch (harvestResult) {
            case OK:
                utils.logWithInterval(`[${creep.name}] 正在采集资源点能量，当前能量：${creep.store[RESOURCE_ENERGY]}/${creep.store.getCapacity(RESOURCE_ENERGY)}`);
                break;
            case ERR_NOT_IN_RANGE:
                utils.moveToTarget(creep, targetSource, "#ffff00");
                utils.logWithInterval(`[${creep.name}] 移动到分配的资源点，准备采集`);
                break;
            default:
                utils.logWithInterval(`[${creep.name}] 采集失败，错误码：${harvestResult}`);
                break;
        }

        // 采集装满，切换为建造状态
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.taskStatus = "building";
            creep.memory.hasJudgedEnergySource = false;
            utils.logWithInterval(`[${creep.name}] 采集装满，切换为建造状态`);
        }
    }

    // 状态3：建造/修复设施（优先建造，无任务则修复，无修复则兜底升级）
    else if (creep.memory.taskStatus === "building") {
        const constructionSites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
        const nearestSite = creep.pos.findClosestByPath(constructionSites, CONFIG.MOVE_CONFIG);

        // 子状态1：优先建造新设施
        if (nearestSite) {
            const buildResult = creep.build(nearestSite);
            switch (buildResult) {
                case OK:
                    utils.logWithInterval(`[${creep.name}] 正在建造${nearestSite.structureType}，剩余能量：${creep.store[RESOURCE_ENERGY]}/${creep.store.getCapacity(RESOURCE_ENERGY)}`);
                    break;
                case ERR_NOT_IN_RANGE:
                    utils.moveToTarget(creep, nearestSite, "#00ff00");
                    utils.logWithInterval(`[${creep.name}] 移动到建筑工地，准备建造`);
                    break;
                default:
                    utils.logWithInterval(`[${creep.name}] 建造失败，错误码：${buildResult}`);
                    break;
            }
        }

        // 子状态2：无建造任务，修复残血设施（优先低血量结构）
        else {
            const damagedStructures = creep.room.find(FIND_MY_STRUCTURES, {
                filter: s => s.hits < s.hitsMax && s.structureType !== STRUCTURE_WALL && s.structureType !== STRUCTURE_RAMPART
            }).sort((a, b) => (a.hits / a.hitsMax) - (b.hits / b.hitsMax)); // 按血量比例升序排序，优先修复残血

            if (damagedStructures.length > 0) {
                const nearestDamaged = creep.pos.findClosestByPath(damagedStructures, CONFIG.MOVE_CONFIG);
                const repairResult = creep.repair(nearestDamaged);
                switch (repairResult) {
                    case OK:
                        utils.logWithInterval(`[${creep.name}] 正在修复${nearestDamaged.structureType}，剩余能量：${creep.store[RESOURCE_ENERGY]}/${creep.store.getCapacity(RESOURCE_ENERGY)}`);
                        break;
                    case ERR_NOT_IN_RANGE:
                        utils.moveToTarget(creep, nearestDamaged, "#00ff99");
                        utils.logWithInterval(`[${creep.name}] 移动到${nearestDamaged.structureType}，准备修复`);
                        break;
                    default:
                        utils.logWithInterval(`[${creep.name}] 修复失败，错误码：${repairResult}`);
                        break;
                }
            }

            // 子状态3：无建造/修复任务，兜底升级控制器
            else {
                const controller = creep.room.controller;
                if (controller && controller.my) {
                    creep.upgradeController(controller);
                    utils.moveToTarget(creep, controller, "#ffffff");
                    utils.logWithInterval(`[${creep.name}] 未找到建筑工地/残血设施，临时升级控制器`);
                }
            }
        }

        // 能量耗尽，等待下次策略判断
        if (creep.store[RESOURCE_ENERGY] <= 0) {
            utils.logWithInterval(`[${creep.name}] 建造/修复能量耗尽，等待下次能源获取判断`);
        }
    }
}

// ------------- 攻击防御型（Defender）：近战防御，优化生存逻辑 -------------
function runDefender(creep) {
    if (!creep) return;

    // 初始化任务状态
    if (!creep.memory.taskStatus) {
        creep.memory.taskStatus = "defending";
    }

    // 状态：执行近战防御/攻击
    if (creep.memory.taskStatus === "defending") {
        const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
        if (hostiles.length > 0) {
            const nearestHostile = creep.pos.findClosestByPath(hostiles, CONFIG.MOVE_CONFIG);
            const attackResult = creep.attack(nearestHostile);

            switch (attackResult) {
                case OK:
                    utils.logWithInterval(`[${creep.name}] 正在攻击敌对Creep，剩余生命值：${creep.hits}/${creep.hitsMax}`);
                    break;
                case ERR_NOT_IN_RANGE:
                    utils.moveToTarget(creep, nearestHostile, "#ff0000");
                    utils.logWithInterval(`[${creep.name}] 移动到敌对Creep附近，准备攻击`);
                    break;
                default:
                    utils.logWithInterval(`[${creep.name}] 攻击失败，错误码：${attackResult}`);
                    break;
            }
        } else {
            // 无敌对目标，返回Spawn待命
            const spawn = Game.spawns[CONFIG.SPAWN_NAME];
            if (spawn) {
                utils.moveToTarget(creep, spawn, "#ff0000");
            }
            utils.logWithInterval(`[${creep.name}] 无敌对目标，在基地附近待命`);
        }
    }
}

// ------------- 远程攻击防御型（RangedDefender）：远程消耗，保持安全距离 -------------
function runRangedDefender(creep) {
    if (!creep) return;

    // 初始化任务状态
    if (!creep.memory.taskStatus) {
        creep.memory.taskStatus = "defending";
    }

    // 状态：执行远程防御/攻击
    if (creep.memory.taskStatus === "defending") {
        const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
        if (hostiles.length > 0) {
            const nearestHostile = creep.pos.findClosestByPath(hostiles, CONFIG.MOVE_CONFIG);
            const rangedResult = creep.rangedAttack(nearestHostile);

            switch (rangedResult) {
                case OK:
                    utils.logWithInterval(`[${creep.name}] 正在远程攻击敌对Creep，剩余生命值：${creep.hits}/${creep.hitsMax}`);
                    break;
                case ERR_NOT_IN_RANGE:
                    // 保持3格安全距离，避免近战
                    utils.moveToTarget(creep, nearestHostile, "#ff6600");
                    creep.pos.rangedMassAttack(); // 附带范围攻击，提升清场效率
                    utils.logWithInterval(`[${creep.name}] 移动到远程攻击范围，准备消耗`);
                    break;
                default:
                    utils.logWithInterval(`[${creep.name}] 远程攻击失败，错误码：${rangedResult}`);
                    break;
            }
        } else {
            // 无敌对目标，返回Spawn待命
            const spawn = Game.spawns[CONFIG.SPAWN_NAME];
            if (spawn) {
                utils.moveToTarget(creep, spawn, "#ff6600");
            }
            utils.logWithInterval(`[${creep.name}] 无敌对目标，在基地附近待命`);
        }
    }
}

// ==================== Creep孵化逻辑（优化效率，补充错误处理） ====================
function spawnCreepIfNeeded() {
    const spawn = Game.spawns[CONFIG.SPAWN_NAME];
    if (!spawn) {
        utils.logWithInterval(`[孵化失败] 未找到Spawn ${CONFIG.SPAWN_NAME}！请手动创建`);
        return;
    }

    // 跳过正在孵化的状态，避免重复尝试
    if (spawn.spawning) {
        const spawningCreep = Game.creeps[spawn.spawning.name];
        if (spawningCreep) {
            utils.logWithInterval(`[孵化中] 正在孵化${spawningCreep.memory && spawningCreep.memory.role}：${spawningCreep.name}`);
        }
        return;
    }

    // 按优先级筛选需要孵化的角色
    const rolesToSpawn = [
        CONFIG.CREEP_ROLES.HARVESTER,
        CONFIG.CREEP_ROLES.CARRIER,
        CONFIG.CREEP_ROLES.UPGRADER,
        CONFIG.CREEP_ROLES.BUILDER,
        CONFIG.CREEP_ROLES.DEFENDER,
        CONFIG.CREEP_ROLES.RANGED_DEFENDER
    ];

    let roleToSpawn = null;
    for (const role of rolesToSpawn) {
        const currentCount = utils.countCreepsByRole(role);
        const minCount = CONFIG.MIN_CREEP_COUNT[role] || 0;
        if (currentCount < minCount) {
            roleToSpawn = role;
            break;
        }
    }

    // 所有角色数量达标，无需孵化
    if (!roleToSpawn) {
        utils.logWithInterval(`[孵化状态] 所有角色数量达标，无需孵化新Creep`);
        return;
    }

    // 计算孵化成本与可用能量
    const creepBody = utils.getCreepBodyByRole(roleToSpawn);
    const creepCost = utils.calculateCreepCost(creepBody);
    const availableEnergy = spawn.room.energyAvailable;

    // 能量不足，无法孵化
    if (availableEnergy < creepCost) {
        utils.logWithInterval(`[孵化失败] 能量不足！需要${creepCost}，当前${availableEnergy}，无法孵化${roleToSpawn}`);
        return;
    }

    // 执行孵化操作，处理错误码
    const creepName = `${roleToSpawn}_${Game.time}`;
    const spawnResult = spawn.spawnCreep(
        creepBody,
        creepName,
        {
            memory: {
                role: roleToSpawn,
                room: CONFIG.ROOM_NAME,
                taskStatus: roleToSpawn === CONFIG.CREEP_ROLES.CARRIER ? "withdrawing" : (roleToSpawn.includes("defender") ? "defending" : "collecting"),
                hasJudgedEnergySource: false
            }
        }
    );

    // 孵化结果日志
    if (spawnResult === OK) {
        utils.logWithInterval(`[孵化成功] 已创建${roleToSpawn}：${creepName}，身体配置：${creepBody.join(", ")}，成本：${creepCost}`);
    } else {
        utils.logWithInterval(`[孵化失败] 错误码：${spawnResult}，无法创建${roleToSpawn}`);
    }
}

// ==================== 主循环（优化流程，减少冗余，提升CPU效率） ====================
module.exports.loop = function () {
    // 步骤1：清理无效内存
    utils.cleanDeadCreepMemory();

    // 步骤2：按需孵化Creep
    spawnCreepIfNeeded();

    // 步骤3：遍历所有存活Creep，执行对应角色逻辑（替换?.为&&）
    for (const creepName in Game.creeps) {
        const creep = Game.creeps[creepName];
        if (!creep) continue;

        switch (creep.memory && creep.memory.role) {
            case CONFIG.CREEP_ROLES.HARVESTER:
                runHarvester(creep);
                break;
            case CONFIG.CREEP_ROLES.CARRIER:
                runCarrier(creep);
                break;
            case CONFIG.CREEP_ROLES.UPGRADER:
                runUpgrader(creep);
                break;
            case CONFIG.CREEP_ROLES.BUILDER:
                runBuilder(creep);
                break;
            case CONFIG.CREEP_ROLES.DEFENDER:
                runDefender(creep);
                break;
            case CONFIG.CREEP_ROLES.RANGED_DEFENDER:
                runRangedDefender(creep);
                break;
            default:
                utils.logWithInterval(`[未知角色] ${creep.name} 角色无效，默认执行采集行为`);
                runHarvester(creep);
                break;
        }
    }
};