/*******************************
 * Screeps 核心任务版代码（6类任务整合）
 * 特性：采集/升级/储能/建造/维修/防御 + 随机Source + Container取能 + 无标签显示
 *******************************/

// ====================== 模块 1：6类核心任务配置（简洁高效，无冗余） ======================
const TaskConfig = {
  tasks: {
    upgrade: { // 1. 升级：最高优先级，房间发展核心
      priority: 10,
      maxWorkers: 8,
      desc: "从Container取能，升级控制器"
    },
    defense: { // 2. 防御：次高优先级，保障房间安全（战时自动提升）
      priority: 9,
      maxWorkers: 2,
      desc: "清除入侵敌对Creep"
    },
    harvest: { // 3. 采集：基础优先级，能量来源保障
      priority: 8,
      maxWorkers: 4,
      desc: "从Source采集能量，存入Container"
    },
    store: { // 4. 储能：辅助优先级，积累能量资源
      priority: 7,
      maxWorkers: 4,
      desc: "前期填充Spawn/Extension，后期填充Storage"
    },
    build: { // 5. 建造：中等优先级，推进基建发展
      priority: 6,
      maxWorkers: 2,
      desc: "优先建造Container/Extension，再普通建造"
    },
    repair: { // 6. 维修：最低优先级，保障设施完好（高能量门槛）
      priority: 5,
      maxWorkers: 1,
      desc: "优先维修核心设施，再维修墙/壁垒"
    }
  },

  // 按房间模式调整任务配置（仅修改优先级，保持核心逻辑）
  adjustTaskConfigByMode(roomMode) {
    const config = JSON.parse(JSON.stringify(this.tasks));

    switch (roomMode) {
      case "bootstrap": // 前期（RCL<3）：优先升级，快速发展
        config.upgrade.priority = 10;
        config.upgrade.maxWorkers = 8;
        break;
      case "defense": // 防御模式：优先防御，其次维修
        config.defense.priority = 10;
        config.repair.priority = 9;
        break;
      case "economy": // 经济模式：优先储能，积累资源
        config.store.priority = 8;
        config.store.maxWorkers = 4;
        break;
    }

    return config;
  },

  // 获取任务最大执行者数量
  getTaskMaxWorkers(taskType, roomMode) {
    const adjustedConfig = this.adjustTaskConfigByMode(roomMode);
    return (adjustedConfig[taskType] && adjustedConfig[taskType].maxWorkers) || 0;
  }
};

// ====================== 模块 2：任务管理器（适配6类任务，保留核心优化） ======================
const TaskManager = {
  // 统计各任务当前执行者数量
  countTaskWorkers(room) {
    const creepList = room.find(FIND_MY_CREEPS);
    const taskCount = {};

    Object.keys(TaskConfig.tasks).forEach(taskType => {
      taskCount[taskType] = 0;
    });

    creepList.forEach(creep => {
      if (creep.memory.currentTask && creep.memory.taskStatus === "executing") {
        const taskType = creep.memory.currentTask;
        if (taskCount.hasOwnProperty(taskType)) {
          taskCount[taskType]++;
        }
      }
    });

    return taskCount;
  },

  // 为Creep分配最优任务（按优先级排序）
  assignOptimalTask(creep) {
    // 任务执行中，直接返回当前任务，不重新分配
    if (creep.memory.currentTask && creep.memory.taskStatus === "executing") {
      return creep.memory.currentTask;
    }

    const room = creep.room;
    const roomMode = Strategy.getRoomMode(room);
    const adjustedTaskConfig = TaskConfig.adjustTaskConfigByMode(roomMode);
    const currentTaskCount = this.countTaskWorkers(room);

    // 按优先级降序排序任务（高优先级在前）
    const sortedTasks = Object.entries(adjustedTaskConfig)
      .sort((a, b) => b[1].priority - a[1].priority)
      .map(([taskType, config]) => ({ taskType, config }));

    // 筛选可用任务：未达数量上限 + 任务可执行
    for (const { taskType, config } of sortedTasks) {
      if (currentTaskCount[taskType] < config.maxWorkers) {
        const taskCanExecute = this._checkTaskExecutable(creep, taskType, roomMode);
        if (taskCanExecute) {
          creep.memory.currentTask = taskType;
          creep.memory.taskStatus = "executing";
          return taskType;
        }
      }
    }

    // 无可用任务，清空状态
    creep.memory.currentTask = null;
    creep.memory.taskStatus = "finished";
    return null;
  },

  // 验证6类任务的可执行性（适配合并后任务）
  _checkTaskExecutable(creep, taskType, roomMode) {
    const room = creep.room;
    const adjustedConfig = TaskConfig.adjustTaskConfigByMode(roomMode);

    switch (taskType) {
      case "harvest":
        // 可执行条件：有可用Source + 采集者未达上限 + Creep有空闲容量
        const availableSources = room.find(FIND_SOURCES, { filter: s => s.energy > 0 });
        const maxHarvesters = adjustedConfig.harvest.maxWorkers;
        const currentHarvesters = this.countTaskWorkers(room).harvest || 0;
        return !!availableSources.length && currentHarvesters < maxHarvesters && creep.store.getFreeCapacity() > 0;

      case "upgrade":
        // 可执行条件：有控制器 + 有可用能量（Container/Source）
        const hasAvailableEnergy = !!room.find(FIND_STRUCTURES, {
          filter: s => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 0
        }).length || !!room.find(FIND_SOURCES, { filter: s => s.energy > 0 }).length;
        return !!(room.controller && room.controller.my) && hasAvailableEnergy;

      case "store":
        // 可执行条件：有需要填充的储能设施（前期Spawn/Extension，后期Storage）
        const energyStructures = room.find(FIND_MY_STRUCTURES, {
          filter: s => {
            const validEarlyTypes = [STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_CONTAINER];
            const validLateTypes = [STRUCTURE_STORAGE];
            const hasFreeCapacity = s.store ? s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 : false;
            return (validEarlyTypes.includes(s.structureType) || (validLateTypes.includes(s.structureType) && room.storage)) && hasFreeCapacity;
          }
        });
        return !!energyStructures.length && creep.store[RESOURCE_ENERGY] > 0;

      case "build":
        // 可执行条件：有建造工地 + Creep携带能量
        const constructionSites = room.find(FIND_CONSTRUCTION_SITES);
        return !!constructionSites.length && creep.store[RESOURCE_ENERGY] > 0;

      case "repair":
        // 可执行条件：有受损设施 + Creep携带能量 + 房间能量充足（避免前期浪费）
        const damagedStructures = room.find(FIND_STRUCTURES, { filter: s => s.hits < s.hitsMax });
        const roomEnergyEnough = room.energyAvailable >= 1000;
        return !!damagedStructures.length && creep.store[RESOURCE_ENERGY] > 0 && roomEnergyEnough;

      case "defense":
        // 可执行条件：有敌对Creep入侵
        const hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
        return !!hostileCreeps.length;

      default:
        return true;
    }
  },

  // 随机分配可用Source（保留核心，解决扎堆问题）
  _getRandomAvailableSource(room, creep) {
    const availableSources = room.find(FIND_SOURCES, { filter: s => s.energy > 0 });
    if (availableSources.length === 0) return null;

    // 统计各Source采集者数量，避免极端随机扎堆
    const sourceLoadMap = {};
    availableSources.forEach(source => {
      sourceLoadMap[source.id] = { source, workerCount: 0 };
    });

    room.find(FIND_MY_CREEPS).forEach(c => {
      const boundSourceId = c.memory.boundSource;
      if (boundSourceId && c.memory.currentTask === "harvest" && c.store.getFreeCapacity() > 0) {
        if (sourceLoadMap[boundSourceId]) sourceLoadMap[boundSourceId].workerCount++;
      }
    });

    // 筛选最少采集者的Source集合，随机选择
    let minWorkerCount = Infinity;
    const lowestLoadSources = [];
    Object.values(sourceLoadMap).forEach(item => {
      if (item.workerCount < minWorkerCount) {
        minWorkerCount = item.workerCount;
        lowestLoadSources.length = 0;
        lowestLoadSources.push(item.source);
      } else if (item.workerCount === minWorkerCount) {
        lowestLoadSources.push(item.source);
      }
    });

    const randomIndex = Math.floor(Math.random() * lowestLoadSources.length);
    return lowestLoadSources[randomIndex];
  },

  // 查找可用能量Container（供upgrade/store任务使用）
  _getAvailableEnergyContainer(creep) {
    const room = creep.room;
    let boundContainer = null;

    // 验证已绑定Container的有效性
    if (creep.memory.boundContainer) {
      boundContainer = Game.getObjectById(creep.memory.boundContainer);
      if (boundContainer && boundContainer.store[RESOURCE_ENERGY] > 0) {
        return boundContainer;
      } else {
        creep.memory.boundContainer = null;
      }
    }

    // 优先查找Source旁有能量的Container，其次查找其他Container
    const sourceContainers = room.find(FIND_STRUCTURES, {
      filter: s => {
        return s.structureType === STRUCTURE_CONTAINER &&
               s.store[RESOURCE_ENERGY] > 0 &&
               room.find(FIND_SOURCES).some(src => src.pos.isNearTo(s.pos));
      }
    });

    if (sourceContainers.length > 0) {
      return creep.pos.findClosestByPath(sourceContainers);
    } else {
      const otherContainers = room.find(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 0
      });
      return otherContainers.length > 0 ? creep.pos.findClosestByPath(otherContainers) : null;
    }
  },

  // 更新任务执行状态
  markTaskStatus(creep, status) {
    creep.memory.taskStatus = status;
  }
};

// ====================== 模块 3：房间策略层（适配6类任务，保留原有模式） ======================
const Strategy = {
  getRoomMode(room) {
    const hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
    if (hostileCreeps.length > 0) return "defense"; // 防御模式：有敌对入侵

    if (room.controller && room.controller.level < 3) return "bootstrap"; // 前期模式：快速升级

    if (room.storage && room.storage.store.energy > 10000) return "economy"; // 经济模式：积累资源

    return "normal"; // 普通模式：均衡发展
  }
};

// ====================== 模块 4：孵化管理器（适配6类任务，双配置Creep） ======================
const SpawnManager = {
  globalMaxCreeps: 50, // 前期可调整为20，RCL≥5后启用50

  // 按房间等级返回Creep配置（前期简易版，后期高效版，防御版备用）
  getCreepBodyByRoomLevel(room) {
    const rcl = room.controller ? room.controller.level : 1;
    const isDefenseMode = Strategy.getRoomMode(room) === "defense";

    // 防御模式：优先孵化带攻击能力的Creep
    if (isDefenseMode) {
      return { body: [ATTACK, TOUGH, MOVE, MOVE], cost: 200 };
    }

    // 普通模式：前期250成本，后期300成本
    if (rcl >= 3) {
      return { body: [WORK, WORK, CARRY, CARRY, MOVE, MOVE], cost: 300 };
    } else {
      return { body: [WORK, CARRY, MOVE, MOVE], cost: 250 };
    }
  },

  spawnOptimizedCreeps(room) {
    const mainSpawn = room.find(FIND_MY_SPAWNS)[0];
    if (!mainSpawn || mainSpawn.spawning) return;

    const roomMode = Strategy.getRoomMode(room);
    const allCreeps = room.find(FIND_MY_CREEPS);
    const totalCreeps = allCreeps.length;
    const taskCount = TaskManager.countTaskWorkers(room);
    const adjustedTaskConfig = TaskConfig.adjustTaskConfigByMode(roomMode);
    const creepConfig = this.getCreepBodyByRoomLevel(room);

    // 检查总Creep数量上限
    if (totalCreeps >= this.globalMaxCreeps) {
      console.log(`[${room.name}] 总Creeps已达上限（${totalCreeps}/${this.globalMaxCreeps}）`);
      return;
    }

    // 检查是否有任务缺人
    const hasTaskShortage = Object.entries(adjustedTaskConfig).some(
      ([taskType, config]) => taskCount[taskType] < config.maxWorkers
    );

    if (!hasTaskShortage) {
      console.log(`[${room.name}] 所有任务执行者充足`);
      return;
    }

    // 检查能量是否充足
    if (room.energyAvailable < creepConfig.cost) {
      console.log(`[${room.name}] 能量不足：孵化需要 ${creepConfig.cost}，当前 ${room.energyAvailable}`);
      return;
    }

    // 孵化Creep，初始化内存
    const creepName = `Worker-${Game.time}`;
    const spawnResult = mainSpawn.spawnCreep(creepConfig.body, creepName, {
      memory: {
        working: false,
        currentTask: null,
        taskStatus: "finished",
        boundSource: null,
        boundContainer: null
      }
    });

    if (spawnResult === OK) {
      console.log(`[${room.name}] 成功孵化Creep：${creepName}（配置：${creepConfig.body.join(',')}）`);
    } else {
      console.log(`[${room.name}] 孵化失败：${this._getSpawnErrorMsg(spawnResult)}`);
    }
  },

  // 错误码映射
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

// ====================== 模块 5：Creep管理器（核心：6类任务执行逻辑） ======================
const CreepManager = {
  // 主逻辑：分发6类任务执行
  runCreepLogic(creep) {
    const currentTask = creep.memory.currentTask || TaskManager.assignOptimalTask(creep);
    if (!currentTask) return;

    // 分发对应任务的执行方法
    switch (currentTask) {
      case "upgrade":
        this._handleUpgradeTask(creep);
        break;
      case "harvest":
        this._handleHarvestTask(creep);
        break;
      case "store":
        this._handleStoreTask(creep);
        break;
      case "build":
        this._handleBuildTask(creep);
        break;
      case "repair":
        this._handleRepairTask(creep);
        break;
      case "defense":
        this._handleDefenseTask(creep);
        break;
      default:
        TaskManager.markTaskStatus(creep, "failed");
        break;
    }
  },

  // 1. 升级任务：从Container取能 → 升级控制器
  _handleUpgradeTask(creep) {
    const room = creep.room;
    const ctrl = room.controller;
    if (!ctrl || !ctrl.my) {
      TaskManager.markTaskStatus(creep, "failed");
      return;
    }

    // 能量不足：从Container取能
    if (creep.store[RESOURCE_ENERGY] === 0) {
      const availableContainer = TaskManager._getAvailableEnergyContainer(creep);
      if (!availableContainer) {
        // 无Container，降级为采集任务
        this._handleHarvestTask(creep);
        return;
      }

      creep.memory.boundContainer = availableContainer.id;
      const withdrawResult = creep.withdraw(availableContainer, RESOURCE_ENERGY);
      if (withdrawResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(availableContainer, {
          reusePath: 50,
          visualizePathStyle: { stroke: "#ffa500" },
          range: 1
        });
      } else if (withdrawResult !== OK) {
        creep.memory.boundContainer = null;
      }
    }
    // 能量充足：升级控制器
    else {
      creep.memory.boundContainer = null;
      const upgradeResult = creep.upgradeController(ctrl);
      if (upgradeResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(ctrl, {
          reusePath: 50,
          range: 3,
          visualizePathStyle: { stroke: "#00aaff" }
        });
      }
    }
  },

  // 2. 采集任务：随机Source采集 → 存入就近Container
  _handleHarvestTask(creep) {
    const room = creep.room;
    let boundSource = null;

    // 读取并验证已绑定的Source
    if (creep.memory.boundSource) {
      boundSource = Game.getObjectById(creep.memory.boundSource);
      if (!boundSource || boundSource.energy <= 0) {
        creep.memory.boundSource = null;
        boundSource = null;
      }
    }

    // 重新绑定随机可用Source
    if (!boundSource) {
      boundSource = TaskManager._getRandomAvailableSource(room, creep);
      if (!boundSource) return;
      creep.memory.boundSource = boundSource.id;
    }

    // 执行采集
    const harvestResult = creep.harvest(boundSource);
    if (harvestResult === ERR_NOT_IN_RANGE) {
      creep.moveTo(boundSource, {
        reusePath: 50,
        visualizePathStyle: { stroke: "#ffaa00" },
        range: 1
      });
    }
    // 采集满能量：存入就近Container
    else if (creep.store.getFreeCapacity() === 0) {
      const nearbyContainer = creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_CONTAINER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
      });

      if (nearbyContainer) {
        const transferResult = creep.transfer(nearbyContainer, RESOURCE_ENERGY);
        if (transferResult === ERR_NOT_IN_RANGE) {
          creep.moveTo(nearbyContainer, { reusePath: 50, visualizePathStyle: { stroke: "#ffcc00" } });
        }
      }
    }
  },

  // 3. 储能任务：前期填充Spawn/Extension → 后期填充Storage
  _handleStoreTask(creep) {
    const room = creep.room;

    // 能量不足：从Container取能
    if (creep.store[RESOURCE_ENERGY] === 0) {
      const availableContainer = TaskManager._getAvailableEnergyContainer(creep);
      if (!availableContainer) return;

      const withdrawResult = creep.withdraw(availableContainer, RESOURCE_ENERGY);
      if (withdrawResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(availableContainer, {
          reusePath: 50,
          visualizePathStyle: { stroke: "#ffd700" },
          range: 1
        });
      }
    }
    // 能量充足：填充储能设施
    else {
      // 优先填充前期设施（Spawn/Extension）
      const earlyEnergyStructures = room.find(FIND_MY_STRUCTURES, {
        filter: s => [STRUCTURE_SPAWN, STRUCTURE_EXTENSION].includes(s.structureType) && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
      });

      // 后期填充Storage
      const lateEnergyStructures = room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_STORAGE && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
      });

      const target = earlyEnergyStructures.length > 0 
        ? creep.pos.findClosestByPath(earlyEnergyStructures)
        : (lateEnergyStructures.length > 0 ? creep.pos.findClosestByPath(lateEnergyStructures) : null);

      if (!target) return;

      const transferResult = creep.transfer(target, RESOURCE_ENERGY);
      if (transferResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, {
          reusePath: 50,
          visualizePathStyle: { stroke: "#00ff00" }
        });
      }
    }
  },

  // 4. 建造任务：优先核心设施 → 普通建造
  _handleBuildTask(creep) {
    const room = creep.room;

    // 能量不足：从Container取能
    if (creep.store[RESOURCE_ENERGY] === 0) {
      const availableContainer = TaskManager._getAvailableEnergyContainer(creep);
      if (!availableContainer) return;

      const withdrawResult = creep.withdraw(availableContainer, RESOURCE_ENERGY);
      if (withdrawResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(availableContainer, {
          reusePath: 50,
          visualizePathStyle: { stroke: "#ffff00" },
          range: 1
        });
      }
    }
    // 能量充足：执行建造
    else {
      // 优先建造核心设施（Container/Extension）
      const coreSites = room.find(FIND_CONSTRUCTION_SITES, {
        filter: s => [STRUCTURE_CONTAINER, STRUCTURE_EXTENSION].includes(s.structureType)
      });

      const allSites = room.find(FIND_CONSTRUCTION_SITES);
      const targetSite = coreSites.length > 0 
        ? creep.pos.findClosestByPath(coreSites)
        : (allSites.length > 0 ? creep.pos.findClosestByPath(allSites) : null);

      if (!targetSite) return;

      const buildResult = creep.build(targetSite);
      if (buildResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(targetSite, {
          reusePath: 50,
          range: 3,
          visualizePathStyle: { stroke: "#ffff00" }
        });
      }
    }
  },

  // 5. 维修任务：优先核心设施 → 高能量门槛维修墙/壁垒
  _handleRepairTask(creep) {
    const room = creep.room;

    // 能量不足：从Container取能
    if (creep.store[RESOURCE_ENERGY] === 0) {
      const availableContainer = TaskManager._getAvailableEnergyContainer(creep);
      if (!availableContainer) return;

      const withdrawResult = creep.withdraw(availableContainer, RESOURCE_ENERGY);
      if (withdrawResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(availableContainer, {
          reusePath: 50,
          visualizePathStyle: { stroke: "#ff00ff" },
          range: 1
        });
      }
    }
    // 能量充足：执行维修
    else {
      // 优先维修核心设施（非墙/壁垒）
      const coreDamaged = room.find(FIND_STRUCTURES, {
        filter: s => s.hits < s.hitsMax * 0.7 && ![STRUCTURE_WALL, STRUCTURE_RAMPART].includes(s.structureType)
      });

      // 后期维修墙/壁垒（高完整度门槛）
      const wallDamaged = room.find(FIND_STRUCTURES, {
        filter: s => [STRUCTURE_WALL, STRUCTURE_RAMPART].includes(s.structureType) && s.hits < s.hitsMax * 0.5
      });

      const targetDamaged = coreDamaged.length > 0 
        ? creep.pos.findClosestByPath(coreDamaged)
        : (wallDamaged.length > 0 ? creep.pos.findClosestByPath(wallDamaged) : null);

      if (!targetDamaged) return;

      const repairResult = creep.repair(targetDamaged);
      if (repairResult === ERR_NOT_IN_RANGE) {
        creep.moveTo(targetDamaged, {
          reusePath: 50,
          visualizePathStyle: { stroke: "#ff00ff" }
        });
      }
    }
  },

  // 6. 防御任务：清除敌对Creep，保障房间安全
  _handleDefenseTask(creep) {
    const room = creep.room;
    const hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
    if (!hostileCreeps.length) {
      TaskManager.markTaskStatus(creep, "finished");
      return;
    }

    // 查找最近的敌对Creep
    const targetHostile = creep.pos.findClosestByPath(hostileCreeps);
    if (!targetHostile) return;

    // 执行攻击
    const attackResult = creep.attack(targetHostile);
    if (attackResult === ERR_NOT_IN_RANGE) {
      creep.moveTo(targetHostile, {
        reusePath: 50,
        visualizePathStyle: { stroke: "#ff0000" }
      });
    }
  }
};

// ====================== 模块 6：数据记录器（适配6类任务统计） ======================
const DataRecorder = {
  recordStats(room) {
    if (!Memory.stats) Memory.stats = {};
    const taskCount = TaskManager.countTaskWorkers(room);
    const ctrlLevel = room.controller && room.controller.level || 0;

    Memory.stats[room.name] = {
      time: Game.time,
      mode: Strategy.getRoomMode(room),
      totalCreeps: room.find(FIND_MY_CREEPS).length,
      energy: room.energyAvailable,
      ctrlLevel: ctrlLevel,
      taskWorkers: taskCount // 统计6类任务的执行者数量
    };

    // 每1000tick输出一次统计日志
    if (Game.time % 1000 === 0) {
      console.log(`[${room.name}] 统计数据：`, JSON.stringify(Memory.stats[room.name]));
    }
  }
};

// ====================== 主循环（简洁高效，清理内存+执行任务） ======================
module.exports.loop = function () {
  // 清理死亡Creep的内存
  for (const name in Memory.creeps) {
    if (!Game.creeps[name]) delete Memory.creeps[name];
  }

  // 遍历所有已占领房间，执行核心逻辑
  const myRooms = Object.values(Game.rooms).filter(r => r.controller && r.controller.my);
  for (const room of myRooms) {
    DataRecorder.recordStats(room);
    SpawnManager.spawnOptimizedCreeps(room);

    for (const creep of room.find(FIND_MY_CREEPS)) {
      CreepManager.runCreepLogic(creep);
    }
  }
};
