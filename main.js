/*******************************
 * Screeps 精准配置版（采集Creep随机分配2个Source+指定任务数量）
 * 特性：采集8个|升级6个|建造维修2个|运输1个|随机分配Source|container满自动切换储能设施
 *******************************/

// ====================== 模块 1：全局配置（保留核心，优化储能设施筛选） ======================
const GlobalConfig = {
  reusePath: 100,
  rangeOptimize: 1,
  // 储能设施优先级排序（从高到低）
  energyStorageStructures: [
    STRUCTURE_SPAWN,
    STRUCTURE_EXTENSION,
    STRUCTURE_TOWER,
    STRUCTURE_STORAGE
  ]
};

// ====================== 模块 2：核心任务配置（精准指定各类任务数量） ======================
const TaskConfig = {
  tasks: {
    harvest: { // 采集：8个
      priority: 10, // 最高优先级，保证能量输入
      maxWorkers: 9,
      desc: "随机分配Source采集，container满则送往各类储能设施"
    },
    upgrade: { // 升级控制器：6个
      priority: 9,
      maxWorkers: 6,
      desc: "从储能设施取能，升级房间控制器"
    },
    build: { // 建造：1个（与维修合计2个）
      priority: 8,
      maxWorkers: 2,
      desc: "能量盈余时，建造建筑设施"
    },
    repair: { // 维修：1个（与建造合计2个）
      priority: 7,
      maxWorkers: 2,
      desc: "能量盈余时，维修受损建筑"
    },
    transport: { // 运输：1个
      priority: 6,
      maxWorkers: 1,
      desc: "转运能量，补充各类储能设施库存"
    }
  },

  // 无需按房间模式调整数量，严格遵循用户指定配置
  adjustTaskConfigByMode(roomMode) {
    const config = JSON.parse(JSON.stringify(this.tasks));
    // 仅在防御模式下提升防御优先级（保留兼容，不修改数量）
    if (roomMode === "defense") {
      const defenseTask = {
        defense: { priority: 11, maxWorkers: 2, desc: "抵御敌对Creep入侵" }
      };
      return Object.assign(defenseTask, config);
    }
    return config;
  },

  getTaskMaxWorkers(taskType, roomMode) {
    const adjustedConfig = this.adjustTaskConfigByMode(roomMode);
    return (adjustedConfig[taskType] && adjustedConfig[taskType].maxWorkers) || 0;
  },

  // 能量盈余判断（用于建造/维修任务触发）
  hasEnergySurplus(room) {
    const storage = room.storage;
    const containerEnergy = room.find(FIND_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 0
    }).reduce((total, container) => total + container.store[RESOURCE_ENERGY], 0);
    // 有storage则判断storage能量≥5000，无storage则判断container能量≥2000
    return storage ? storage.store[RESOURCE_ENERGY] >= 5000 : containerEnergy >= 2000;
  },

  // 筛选可用的储能设施（spawn/extension/tower/storage）
  getAvailableEnergyStructures(room) {
    const targets = [];
    GlobalConfig.energyStorageStructures.forEach(structType => {
      const structs = room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === structType && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
      });
      if (structs.length > 0) targets.push(...structs);
    });
    return targets;
  },

  // 判断container是否已满
  isContainerFull(container) {
    return container.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
  }
};

// ====================== 模块 3：任务管理器（核心修改：采集Creep随机分配Source） ======================
const TaskManager = {
  countTaskWorkers(room) {
    const creepList = room.find(FIND_MY_CREEPS);
    const taskCount = {};

    // 初始化所有任务数量为0
    Object.keys(TaskConfig.tasks).forEach(taskType => {
      taskCount[taskType] = 0;
    });

    // 统计当前各任务的Creep数量
    creepList.forEach(creep => {
      if (creep.memory.currentTask && taskCount.hasOwnProperty(creep.memory.currentTask)) {
        taskCount[creep.memory.currentTask]++;
      }
    });

    return taskCount;
  },

  assignOptimalTask(creep) {
    // 任务一旦分配，不中途更换（确保数量稳定，避免频繁切换）
    if (creep.memory.currentTask) {
      return creep.memory.currentTask;
    }

    const room = creep.room;
    const roomMode = Strategy.getRoomMode(room);
    const adjustedConfig = TaskConfig.adjustTaskConfigByMode(roomMode);
    const currentTaskCount = this.countTaskWorkers(room);
    const hasEnergySurplus = TaskConfig.hasEnergySurplus(room);

    // 按优先级排序，精准分配任务（严格控制不超过maxWorkers）
    const sortedTasks = Object.entries(adjustedConfig)
      .sort((a, b) => b[1].priority - a[1].priority)
      .map(([taskType, config]) => ({ taskType, config }));

    for (const { taskType, config } of sortedTasks) {
      // 跳过已达数量上限的任务
      if (currentTaskCount[taskType] >= config.maxWorkers) continue;

      // 建造/维修任务需满足能量盈余条件
      if ((taskType === "build" || taskType === "repair") && !hasEnergySurplus) continue;

      // 验证任务是否可执行
      if (this._checkTaskExecutable(creep, taskType, room)) {
        creep.memory.currentTask = taskType;
        console.log(`[${creep.name}] 分配任务：${taskType}（当前数量：${currentTaskCount[taskType]+1}/${config.maxWorkers}）`);
        return taskType;
      }
    }

    // 兜底：分配采集任务（确保无Creep闲置）
    creep.memory.currentTask = "harvest";
    return "harvest";
  },

  _checkTaskExecutable(creep, taskType, room) {
    switch (taskType) {
      case "harvest":
        return !!room.find(FIND_SOURCES, { filter: s => s.energy > 0 }).length;
      case "upgrade":
        return !!(room.controller && room.controller.my) && !!this._getAvailableEnergyContainer(creep).length;
      case "build":
        return !!room.find(FIND_CONSTRUCTION_SITES).length;
      case "repair":
        return !!room.find(FIND_STRUCTURES, { filter: s => s.hits < s.hitsMax * 0.95 }).length;
      case "transport":
        return !!TaskConfig.getAvailableEnergyStructures(room).length && !!this._getAvailableEnergyContainer(creep).length;
      case "defense":
        return !!room.find(FIND_HOSTILE_CREEPS).length;
      default:
        return true;
    }
  },

  // ====================== 核心修改：随机分配可用Source ======================
  _getAvailableSource(creep) {
    const room = creep.room;
    // 1. 获取所有能量>0的可用Source
    const availableSources = room.find(FIND_SOURCES, { filter: s => s.energy > 0 });
    if (availableSources.length === 0) return null;
    // 2. 随机选择一个Source（核心：从可用数组中随机取，实现2个Source的均匀分配）
    const randomIndex = Math.floor(Math.random() * availableSources.length);
    return availableSources[randomIndex];
  },

  // 获取有能量的container（数组形式，方便运输任务筛选）
  _getAvailableEnergyContainer(creep) {
    const room = creep.room;
    return room.find(FIND_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 0
    });
  },

  // 获取最近的有能量container
  getClosestEnergyContainer(creep) {
    const containers = this._getAvailableEnergyContainer(creep);
    if (containers.length === 0) return null;
    return creep.pos.findClosestByPath(containers);
  }
};

// ====================== 模块 4：房间策略层（保留核心模式） ======================
const Strategy = {
  getRoomMode(room) {
    const hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
    if (hostileCreeps.length > 0) return "defense";

    if (room.controller && room.controller.level < 3) return "bootstrap";

    if (room.storage && room.storage.store.energy > 20000) return "economy";

    return "normal";
  }
};

// ====================== 模块 5：孵化管理器（适配不同任务Creep身体配置） ======================
const SpawnManager = {
  globalMaxCreeps: 25, // 8+6+1+1+1=17，匹配用户指定总数量
  minCreepThreshold: 20,

  // 不同任务Creep的身体配置（按需优化能力）
  getCreepBodyByTask(taskType) {
    switch (taskType) {
      case "harvest": // 采集Creep：侧重采集和移动，兼顾携带
        return { body: [WORK, CARRY, MOVE, MOVE], cost: 200 };
      case "upgrade": // 升级Creep：侧重携带和移动，保证持续升级
        return { body: [CARRY, CARRY, MOVE, WORK], cost: 200 };
      case "build": // 建造Creep：兼顾携带和建造
        return { body: [WORK, CARRY, MOVE, CARRY], cost: 200 };
      case "repair": // 维修Creep：同建造Creep配置
        return { body: [WORK, CARRY, MOVE, CARRY], cost: 200 };
      case "transport": // 运输Creep：侧重携带能力
        return { body: [CARRY, CARRY, CARRY, MOVE, MOVE], cost: 250 };
      case "defense": // 防御Creep：基础攻击配置
        return { body: [ATTACK, MOVE, ATTACK], cost: 150 };
      default: // 默认：采集配置
        return { body: [WORK, CARRY, MOVE], cost: 150 };
    }
  },

  spawnOptimizedCreeps(room) {
    const mainSpawn = room.find(FIND_MY_SPAWNS)[0];
    if (!mainSpawn || mainSpawn.spawning) return;

    const roomMode = Strategy.getRoomMode(room);
    const allCreeps = room.find(FIND_MY_CREEPS);
    const totalCreeps = allCreeps.length;
    const currentTaskCount = TaskManager.countTaskWorkers(room);
    const adjustedConfig = TaskConfig.adjustTaskConfigByMode(roomMode);

    // 未达总数量阈值，优先孵化缺口最大的任务Creep
    if (totalCreeps < this.minCreepThreshold) {
      // 找出缺口最大的任务
      let maxShortageTask = "harvest";
      let maxShortage = 0;
      Object.entries(adjustedConfig).forEach(([taskType, config]) => {
        const shortage = config.maxWorkers - (currentTaskCount[taskType] || 0);
        if (shortage > maxShortage) {
          maxShortage = shortage;
          maxShortageTask = taskType;
        }
      });

      // 孵化对应任务的Creep
      const creepConfig = this.getCreepBodyByTask(maxShortageTask);
      if (room.energyAvailable < creepConfig.cost) {
        console.log(`[${room.name}] 孵化能量不足（需要 ${creepConfig.cost}，当前 ${room.energyAvailable}）`);
        return;
      }

      const creepName = `${maxShortageTask}-${Game.time}`;
      const spawnResult = mainSpawn.spawnCreep(creepConfig.body, creepName, {
        memory: {
          currentTask: null,
          boundSource: null,
          taskType: maxShortageTask // 标记任务类型，方便后续分配
        }
      });

      if (spawnResult === OK) {
        console.log(`[${room.name}] 孵化成功：${creepName}（${maxShortageTask}任务，当前总数量：${totalCreeps+1}/${this.minCreepThreshold}）`);
      }
      return;
    }

    console.log(`[${room.name}] Creep数量已达上限（${totalCreeps}/${this.minCreepThreshold}）`);
  },

  _getSpawnErrorMsg(errorCode) {
    const errorMap = {
      [ERR_NOT_ENOUGH_ENERGY]: "能量不足",
      [ERR_NAME_EXISTS]: "名称已存在",
      [ERR_BUSY]: "Spawn正忙",
      [ERR_RCL_NOT_ENOUGH]: "控制器等级不足"
    };
    return errorMap[errorCode] || `未知错误（${errorCode}）`;
  }
};

// ====================== 模块 6：Creep管理器（保留采集交付逻辑） ======================
const CreepManager = {
  runCreepLogic(creep) {
    // 分配任务（确保每个Creep都有对应任务）
    const currentTask = creep.memory.currentTask || TaskManager.assignOptimalTask(creep);
    if (!currentTask) return;

    // 执行对应任务
    switch (currentTask) {
      case "harvest":
        this._handleHarvestTask(creep); // 核心：优化container满时的交付逻辑
        break;
      case "upgrade":
        this._handleUpgradeTask(creep);
        break;
      case "build":
        this._handleBuildTask(creep);
        break;
      case "repair":
        this._handleRepairTask(creep);
        break;
      case "transport":
        this._handleTransportTask(creep);
        break;
      case "defense":
        this._handleDefenseTask(creep);
        break;
      default:
        creep.memory.currentTask = "harvest";
        this._handleHarvestTask(creep);
        break;
    }
  },

  // 采集任务：container满则送往spawn/extension/tower/storage
  _handleHarvestTask(creep) {
    const room = creep.room;
    let source = null;

    // 绑定/验证Source（使用随机分配的Source）
    if (creep.memory.boundSource) {
      source = Game.getObjectById(creep.memory.boundSource);
    }
    if (!source || source.energy <= 0) {
      source = TaskManager._getAvailableSource(creep);
      if (!source) {
        console.log(`[${creep.name}] 无可用Source，暂停工作`);
        return;
      }
      creep.memory.boundSource = source.id;
    }

    // 空能量→采集
    if (creep.store.getFreeCapacity() > 0) {
      const harvestResult = creep.harvest(source);
      if (harvestResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(source, {
          reusePath: GlobalConfig.reusePath,
          range: GlobalConfig.rangeOptimize,
          visualizePathStyle: { stroke: "#ffaa00" }
        });
      }
    }
    // 满能量→交付（优先判断container是否可用）
    else {
      // 1. 查找最近的非满container
      const containers = room.find(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_CONTAINER && !TaskConfig.isContainerFull(s)
      });
      const targetContainer = creep.pos.findClosestByPath(containers);

      // 2. container可用（未满）→ 送往container
      if (targetContainer) {
        const transferResult = creep.transfer(targetContainer, RESOURCE_ENERGY);
        if (transferResult === ERR_NOT_IN_RANGE) {
          creep.moveTo(targetContainer, {
            reusePath: GlobalConfig.reusePath,
            range: GlobalConfig.rangeOptimize,
            visualizePathStyle: { stroke: "#ffcc00" }
          });
        }
      }
      // 3. container已满/无可用container→ 送往spawn/extension/tower/storage
      else {
        const energyStructures = TaskConfig.getAvailableEnergyStructures(room);
        if (energyStructures.length === 0) {
          console.log(`[${creep.name}] 无可用储能设施，暂无法交付`);
          return;
        }

        const targetStructure = creep.pos.findClosestByPath(energyStructures);
        const transferResult = creep.transfer(targetStructure, RESOURCE_ENERGY);
        if (transferResult === ERR_NOT_IN_RANGE) {
          creep.moveTo(targetStructure, {
            reusePath: GlobalConfig.reusePath,
            range: GlobalConfig.rangeOptimize,
            visualizePathStyle: { stroke: "#00ff00" }
          });
        }
      }
    }
  },

  // 升级控制器任务
  _handleUpgradeTask(creep) {
    const room = creep.room;
    const ctrl = room.controller;
    if (!ctrl || !ctrl.my) return;

    // 空能量→从container取能
    if (creep.store[RESOURCE_ENERGY] === 0) {
      const container = TaskManager.getClosestEnergyContainer(creep);
      if (!container) {
        this._handleHarvestTask(creep);
        return;
      }
      const withdrawResult = creep.withdraw(container, RESOURCE_ENERGY);
      if (withdrawResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(container, {
          reusePath: GlobalConfig.reusePath,
          range: GlobalConfig.rangeOptimize
        });
      }
    }
    // 有能量→升级控制器
    else {
      const upgradeResult = creep.upgradeController(ctrl);
      if (upgradeResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(ctrl, {
          reusePath: GlobalConfig.reusePath,
          range: 3
        });
      }
    }
  },

  // 建造任务
  _handleBuildTask(creep) {
    const room = creep.room;
    const sites = room.find(FIND_CONSTRUCTION_SITES);
    if (!sites.length) return;

    // 空能量→从container取能
    if (creep.store[RESOURCE_ENERGY] === 0) {
      const container = TaskManager.getClosestEnergyContainer(creep);
      if (!container) return;
      const withdrawResult = creep.withdraw(container, RESOURCE_ENERGY);
      if (withdrawResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(container, {
          reusePath: GlobalConfig.reusePath,
          range: GlobalConfig.rangeOptimize
        });
      }
    }
    // 有能量→建造
    else {
      const target = creep.pos.findClosestByPath(sites);
      const buildResult = creep.build(target);
      if (buildResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {
          reusePath: GlobalConfig.reusePath,
          range: 3
        });
      }
    }
  },

  // 维修任务
  _handleRepairTask(creep) {
    const room = creep.room;
    const damaged = room.find(FIND_STRUCTURES, { filter: s => s.hits < s.hitsMax * 0.95 });
    if (!damaged.length) return;

    // 空能量→从container取能
    if (creep.store[RESOURCE_ENERGY] === 0) {
      const container = TaskManager.getClosestEnergyContainer(creep);
      if (!container) return;
      const withdrawResult = creep.withdraw(container, RESOURCE_ENERGY);
      if (withdrawResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(container, {
          reusePath: GlobalConfig.reusePath,
          range: GlobalConfig.rangeOptimize
        });
      }
    }
    // 有能量→维修
    else {
      const target = creep.pos.findClosestByPath(damaged);
      const repairResult = creep.repair(target);
      if (repairResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {
          reusePath: GlobalConfig.reusePath
        });
      }
    }
  },

  // 运输任务（从container转运能量到各类储能设施）
  _handleTransportTask(creep) {
    const room = creep.room;

    // 空能量→从container取能
    if (creep.store.getFreeCapacity() > 0) {
      const container = TaskManager.getClosestEnergyContainer(creep);
      if (!container) return;
      const withdrawResult = creep.withdraw(container, RESOURCE_ENERGY);
      if (withdrawResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(container, {
          reusePath: GlobalConfig.reusePath,
          range: GlobalConfig.rangeOptimize
        });
      }
    }
    // 有能量→送往储能设施
    else {
      const energyStructures = TaskConfig.getAvailableEnergyStructures(room);
      if (energyStructures.length === 0) return;

      const targetStructure = creep.pos.findClosestByPath(energyStructures);
      const transferResult = creep.transfer(targetStructure, RESOURCE_ENERGY);
      if (transferResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(targetStructure, {
          reusePath: GlobalConfig.reusePath,
          range: GlobalConfig.rangeOptimize
        });
      }
    }
  },

  // 防御任务
  _handleDefenseTask(creep) {
    const room = creep.room;
    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    if (!hostiles.length) return;

    const target = creep.pos.findClosestByPath(hostiles);
    const attackResult = creep.attack(target);
    if (attackResult === ERR_NOT_IN_RANGE) {
      creep.moveTo(target, {
        reusePath: GlobalConfig.reusePath
      });
    }
  }
};

// ====================== 模块 7：主循环（确保逻辑执行流畅） ======================
module.exports.loop = function () {
  // 清理死亡Creep内存
  for (const name in Memory.creeps) {
    if (!Game.creeps[name]) {
      delete Memory.creeps[name];
      console.log(`[清理内存] 移除死亡Creep：${name}`);
    }
  }

  // 遍历房间执行逻辑
  const myRooms = Object.values(Game.rooms).filter(r => r.controller && r.controller.my);
  for (const room of myRooms) {
    SpawnManager.spawnOptimizedCreeps(room);

    // 执行所有Creep逻辑
    const creeps = room.find(FIND_MY_CREEPS);
    for (const creep of creeps) {
      CreepManager.runCreepLogic(creep);
    }
  }
};
