/* ===== 全局命名空间 ===== */
window.Studio = window.Studio || {};

/* ===== 默认棚 + 默认摆法 ===== */
(function (S) {
  const PX_PER_M = 100; // 画布：1 米 = 100 像素
  S.PX_PER_M = PX_PER_M;
  S.WORLD_PAD = 40;     // 世界相对视口的留白
  S.GRID = 0.05;        // 网格吸附 5cm

  function defaultDoc() {
    const room = {
      w: 10, h: 7,
      doors: [
        { wall: "south", at: 5, width: 1 },
        { wall: "west", at: 3.5, width: 0.9 }
      ],
      outletCap: 3
    };

    const devices = [
      { id: "dev-L1", kind: "light", name: "主灯 Aputure 300", heldBy: "" },
      { id: "dev-L2", kind: "light", name: "补光灯 南光 200", heldBy: "" },
      { id: "dev-L3", kind: "light", name: "轮廓灯 神牛 ML60", heldBy: "" },
      { id: "dev-S1", kind: "stand", name: "2.8m 重型支架 ×3", heldBy: "" },
      { id: "dev-B1", kind: "backdrop", name: "3.5m 灰背景板", heldBy: "" }
    ];

    const planA = makePlan("plan-a", "摆法 A", S.defaultEntitiesA());
    const planB = makePlan("plan-b", "摆法 B", S.defaultEntitiesB());

    return {
      version: 1,
      revision: 3,
      activePlanId: "plan-a",
      room,
      devices,
      plans: [planA, planB]
    };
  }

  function makePlan(id, name, entities) {
    return {
      id, name, revision: 1,
      entities,
      outlets: defaultOutlets(),
      waivers: {},
      resolved: [],
      dismissedSeen: {}
    };
  }

  function defaultOutlets() {
    return [
      { id: "o1", name: "南墙插座 1", wall: "south", at: 2.5 },
      { id: "o2", name: "南墙插座 2", wall: "south", at: 7.5 },
      { id: "o3", name: "北墙插座", wall: "north", at: 5 },
      { id: "o4", name: "西墙插座", wall: "west", at: 1.2 }
    ];
  }

  S.defaultDoc = defaultDoc;
  S.PX_PER_M = PX_PER_M;
})(window.Studio);

/* ===== 摆法 A：标准三点布光 ===== */
(function (S) {
  function defaultEntitiesA() {
    return [
      { id: "bd1", type: "backdrop", deviceId: "dev-B1", name: "灰背景板",
        x: 1.7, y: 0.3, w: 3.4, h: 0.25, angle: 0, confirmed: true },
      { id: "ar1", type: "area", name: "主拍摄区",
        x: 1.4, y: 0.55, w: 4.0, h: 2.8 },
      { id: "sb1", type: "subject", name: "人物站位",
        x: 3.4, y: 2.1 },
      { id: "l1", type: "light", deviceId: "dev-L1", name: "主灯",
        x: 1.3, y: 2.6, angle: -35, spread: 40, reach: 4.5,
        leader: true, followers: ["l2", "l3"], outletId: "o4",
        cableLen: 5, cable: { bx: 0.1, by: 1.9 }, confirmed: true },
      { id: "l2", type: "light", deviceId: "dev-L2", name: "补光灯",
        x: 5.6, y: 2.3, angle: 200, spread: 45, reach: 4.5,
        leader: false, followers: [], outletId: "o2",
        cableLen: 4, cable: { bx: 5.6, by: 6.4 }, confirmed: true },
      { id: "l3", type: "light", deviceId: "dev-L3", name: "轮廓灯",
        x: 4.6, y: 0.7, angle: 140, spread: 35, reach: 3.5,
        leader: false, followers: [], outletId: "o3",
        cableLen: 3, cable: { bx: 4.8, by: 0.15 }, confirmed: true },
      { id: "st1", type: "stand", deviceId: "dev-S1", name: "反光板支架",
        x: 0.9, y: 3.6, angle: 0, confirmed: true }
    ];
  }

  /* ===== 摆法 B：主灯移到机位后方，试验窄区布光 ===== */
  function defaultEntitiesB() {
    return [
      { id: "bd1", type: "backdrop", deviceId: "dev-B1", name: "灰背景板",
        x: 3.3, y: 0.3, w: 3.4, h: 0.25, angle: 0, confirmed: true },
      { id: "ar1", type: "area", name: "窄拍摄区",
        x: 3.0, y: 0.55, w: 4.0, h: 2.6 },
      { id: "sb1", type: "subject", name: "人物站位",
        x: 5.0, y: 2.0 },
      { id: "l1", type: "light", deviceId: "dev-L1", name: "主灯",
        x: 5.0, y: 4.8, angle: 90, spread: 38, reach: 4.0,
        leader: true, followers: ["l2"], outletId: "o2",
        cableLen: 3, cable: { bx: 6.5, by: 4.8 }, confirmed: false },
      { id: "l2", type: "light", deviceId: "dev-L2", name: "补光灯",
        x: 7.8, y: 3.0, angle: 180, spread: 45, reach: 4.0,
        leader: false, followers: [], outletId: "o2",
        cableLen: 3, cable: { bx: 7.8, by: 6.4 }, confirmed: false },
      { id: "l3", type: "light", deviceId: "dev-L3", name: "轮廓灯",
        x: 6.9, y: 0.8, angle: 160, spread: 35, reach: 3.0,
        leader: false, followers: [], outletId: "o3",
        cableLen: 3, cable: { bx: 6.6, by: 0.15 }, confirmed: false },
      { id: "st1", type: "stand", deviceId: "dev-S1", name: "反光板支架",
        x: 2.4, y: 3.2, angle: 0, confirmed: false }
    ];
  }

  S.defaultEntitiesA = defaultEntitiesA;
  S.defaultEntitiesB = defaultEntitiesB;
})(window.Studio);
