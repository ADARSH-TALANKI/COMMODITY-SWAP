const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (x) => ethers.parseEther(String(x));
const P = (x) => ethers.parseUnits(String(x), 8); // oracle price, 8 decimals, ETH per unit

const FEE = E("0.01");
const GRACE = 60;
const MIN_PERIOD = 300;
const SELECT_WINDOW = 600;
const PERIOD = 300;
const QTY = 10;
const COLL = E(3);

describe("CommSwap v2", function () {
  let swap, feed, owner, alice, bob, carol, dave, mallory;

  async function setPrice(x) {
    await feed.connect(owner).updateAnswer(P(x));
  }

  // alice proposes LONG, bob + carol accept, alice picks bob -> swap 0
  async function openSwap({ periods = 3, coll = COLL, long = true } = {}) {
    await swap.connect(alice).createRequest(0, QTY, long, PERIOD, periods, 600, { value: coll });
    const rid = (await swap.requestCount()) - 1n;
    await swap.connect(bob).acceptRequest(rid, { value: coll });
    await swap.connect(carol).acceptRequest(rid, { value: coll });
    await swap.connect(alice).selectCounterparty(rid, bob.address);
    const sid = (await swap.swapCount()) - 1n;
    return { rid, sid };
  }

  // moves time to the scheduled time of the next round (plus a bit) and keeps the oracle fresh
  async function toRound(sid, round, priceAtSchedule) {
    const t = await swap.scheduledTime(sid, round);
    await time.increaseTo(t - 5n);
    if (priceAtSchedule !== undefined) await setPrice(priceAtSchedule);
    await time.increaseTo(t + 1n);
  }

  beforeEach(async function () {
    [owner, alice, bob, carol, dave, mallory] = await ethers.getSigners();
    const Feed = await ethers.getContractFactory("MockV3Aggregator");
    feed = await Feed.deploy(8, P("1.00"), "GOLD / ETH");
    const Swap = await ethers.getContractFactory("CommSwap");
    swap = await Swap.deploy(FEE, GRACE, MIN_PERIOD, SELECT_WINDOW);
    await swap.addCommodity("GOLD", await feed.getAddress(), 86400);
    for (const u of [alice, bob, carol, dave]) await swap.connect(u).register({ value: FEE });
  });

  describe("Module 1: registration", function () {
    it("new user starts at reputation 5 and the fee goes to the insurance pool", async function () {
      const u = await swap.users(alice.address);
      expect(u.registered).to.equal(true);
      expect(u.reputation).to.equal(5);
      expect(await swap.insuranceFund()).to.equal(FEE * 4n);
    });
    it("rejects double registration and wrong fee", async function () {
      await expect(swap.connect(alice).register({ value: FEE })).to.be.revertedWith("Already registered");
      await expect(swap.connect(mallory).register({ value: E("0.001") })).to.be.revertedWith("Wrong registration fee");
    });
    it("only registered users can propose or accept", async function () {
      await expect(swap.connect(mallory).createRequest(0, QTY, true, PERIOD, 3, 600, { value: COLL })).to.be.revertedWith(
        "Not registered"
      );
    });
    it("only the owner can map commodities to oracle feeds", async function () {
      await expect(swap.connect(alice).addCommodity("FAKE", await feed.getAddress(), 1)).to.be.revertedWithCustomError(
        swap,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Module 1: proposals", function () {
    it("reference price K is snapshotted from the oracle, not typed by the user", async function () {
      await setPrice("1.37");
      await swap.connect(alice).createRequest(0, QTY, true, PERIOD, 3, 600, { value: COLL });
      expect((await swap.getRequest(0)).refPrice).to.equal(P("1.37"));
    });
    it("validates inputs", async function () {
      const c = swap.connect(alice);
      await expect(c.createRequest(5, QTY, true, PERIOD, 3, 600, { value: COLL })).to.be.revertedWith("Unknown commodity");
      await expect(c.createRequest(0, 0, true, PERIOD, 3, 600, { value: COLL })).to.be.revertedWith("Bad quantity");
      await expect(c.createRequest(0, QTY, true, 10, 3, 600, { value: COLL })).to.be.revertedWith("Period too short");
      await expect(c.createRequest(0, QTY, true, PERIOD, 0, 600, { value: COLL })).to.be.revertedWith("Bad number of periods");
      await expect(c.createRequest(0, QTY, true, PERIOD, 53, 600, { value: COLL })).to.be.revertedWith("Bad number of periods");
      await expect(c.createRequest(0, QTY, true, PERIOD, 3, 600, { value: 0 })).to.be.revertedWith("Need collateral");
    });
    it("rejects proposals when the oracle is stale", async function () {
      await time.increase(86401);
      await expect(swap.connect(alice).createRequest(0, QTY, true, PERIOD, 3, 600, { value: COLL })).to.be.revertedWith(
        "Stale oracle price"
      );
    });
    it("acceptance checks: own, wrong collateral, duplicate, late", async function () {
      await swap.connect(alice).createRequest(0, QTY, true, PERIOD, 3, 600, { value: COLL });
      await expect(swap.connect(alice).acceptRequest(0, { value: COLL })).to.be.revertedWith("Creator cannot accept own");
      await expect(swap.connect(bob).acceptRequest(0, { value: E(1) })).to.be.revertedWith("Wrong collateral");
      await swap.connect(bob).acceptRequest(0, { value: COLL });
      await expect(swap.connect(bob).acceptRequest(0, { value: COLL })).to.be.revertedWith("Already accepted");
      await time.increase(601);
      await expect(swap.connect(carol).acceptRequest(0, { value: COLL })).to.be.revertedWith("Too late to accept");
    });
    it("acceptance records timestamp + reputation snapshot", async function () {
      await swap.connect(alice).createRequest(0, QTY, true, PERIOD, 3, 600, { value: COLL });
      await swap.connect(bob).acceptRequest(0, { value: COLL });
      const a = await swap.getAcceptances(0);
      expect(a[0].acceptor).to.equal(bob.address);
      expect(a[0].reputationSnapshot).to.equal(5);
      expect(a[0].acceptedAt).to.be.gt(0);
    });
    it("only the creator selects, and only an acceptor can be selected", async function () {
      await swap.connect(alice).createRequest(0, QTY, true, PERIOD, 3, 600, { value: COLL });
      await swap.connect(bob).acceptRequest(0, { value: COLL });
      await expect(swap.connect(bob).selectCounterparty(0, bob.address)).to.be.revertedWith("Only creator");
      await expect(swap.connect(alice).selectCounterparty(0, carol.address)).to.be.revertedWith("Not an acceptor");
    });
    it("non-selected acceptors pull their refund; the selected one cannot", async function () {
      const { rid } = await openSwap();
      await expect(swap.connect(bob).withdrawAcceptance(rid)).to.be.revertedWith("Already withdrawn");
      await swap.connect(carol).withdrawAcceptance(rid);
      expect(await swap.withdrawable(carol.address)).to.equal(COLL);
      await expect(() => swap.connect(carol).withdraw()).to.changeEtherBalance(carol, COLL);
    });
    it("acceptor funds can never get stuck: withdraw before selection, creator can cancel, anyone can expire", async function () {
      await swap.connect(alice).createRequest(0, QTY, true, PERIOD, 3, 600, { value: COLL });
      await swap.connect(bob).acceptRequest(0, { value: COLL });
      await swap.connect(bob).withdrawAcceptance(0);
      expect(await swap.withdrawable(bob.address)).to.equal(COLL);
      await expect(swap.connect(carol).cancelRequest(0)).to.be.revertedWith("Only creator before expiry");
      await time.increase(600 + SELECT_WINDOW + 1);
      await expect(swap.connect(alice).selectCounterparty(0, bob.address)).to.be.revertedWith("Selection window over");
      await swap.connect(carol).cancelRequest(0); // anyone can expire
      expect(await swap.withdrawable(alice.address)).to.equal(COLL);
    });
    it("a malicious acceptor that rejects ETH cannot block selection (pull payments, no loops)", async function () {
      const Evil = await ethers.getContractFactory("RejectingAcceptor");
      const evil = await Evil.deploy(await swap.getAddress());
      await evil.registerSelf({ value: FEE });
      await swap.connect(alice).createRequest(0, QTY, true, PERIOD, 3, 600, { value: COLL });
      await evil.accept(0, { value: COLL });
      await swap.connect(bob).acceptRequest(0, { value: COLL });
      await expect(swap.connect(alice).selectCounterparty(0, bob.address)).to.emit(swap, "SwapStarted");
    });
  });

  describe("Module 3: settlement economics", function () {
    it("long wins when P > K: (P-K)*Q moves from short to long, stays locked", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "1.10");
      await expect(swap.settle(sid, 0))
        .to.emit(swap, "Settled")
        .withArgs(sid, 1, P("1.10"), P("0.10"), E(1), E(1), alice.address);
      const [L, S] = await swap.getParties(sid);
      expect(L.collateral).to.equal(E(4));
      expect(S.collateral).to.equal(E(2));
      expect(await swap.withdrawable(alice.address)).to.equal(0); // locked until maturity
    });
    it("short wins when P < K", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "0.95");
      await swap.settle(sid, 0);
      const [L, S] = await swap.getParties(sid);
      expect(L.collateral).to.equal(E("2.5"));
      expect(S.collateral).to.equal(E("3.5"));
    });
    it("proposer can be the SHORT side too", async function () {
      const { sid } = await openSwap({ long: false });
      const s = await swap.getSwap(sid);
      expect(s.longParty).to.equal(bob.address);
      expect(s.shortParty).to.equal(alice.address);
    });
    it("P == K: no transfer", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "1.00");
      await swap.settle(sid, 0);
      const [L, S] = await swap.getParties(sid);
      expect(L.collateral).to.equal(COLL);
      expect(S.collateral).to.equal(COLL);
    });
    it("true swap semantics: same price two periods in a row pays TWICE (Alg 5 lastPrice bug fixed)", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "1.10");
      await swap.settle(sid, 0);
      await swap.connect(bob).topUp(sid, { value: E(1) });
      await toRound(sid, 2, "1.10");
      await swap.settle(sid, 0);
      const [L] = await swap.getParties(sid);
      expect(L.collateral).to.equal(E(5)); // 3 + 1 + 1
    });
    it("too early settlement reverts; quantity is not a caller input", async function () {
      const { sid } = await openSwap();
      await expect(swap.settle(sid, 0)).to.be.revertedWith("Too early for settlement");
    });
    it("clean settlement gives +1 reputation to both parties, capped at 10", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "1.00");
      await swap.settle(sid, 0);
      expect((await swap.users(alice.address)).reputation).to.equal(6);
      expect((await swap.users(bob.address)).reputation).to.equal(6);
    });
    it("maturity: all rounds done -> both balances become withdrawable", async function () {
      const { sid } = await openSwap({ periods: 2 });
      await toRound(sid, 1, "1.10");
      await swap.settle(sid, 0);
      await swap.connect(bob).topUp(sid, { value: E(1) });
      await toRound(sid, 2, "0.90");
      await expect(swap.settle(sid, 0)).to.emit(swap, "SwapMatured");
      // long: 3 +1 -1 = 3 ; short: 3 -1 +1(topup) +1 = 4
      expect(await swap.withdrawable(alice.address)).to.equal(E(3));
      expect(await swap.withdrawable(bob.address)).to.equal(E(4));
      expect((await swap.getSwap(sid)).status).to.equal(2); // Matured
      expect((await swap.users(alice.address)).swapsCompleted).to.equal(1);
    });
  });

  describe("Front-running / settlement-timing defence", function () {
    it("price is taken at the SCHEDULED time: calling settle late after a price jump changes nothing", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "1.10"); // live at scheduled time
      await time.increase(100);
      await setPrice("2.00"); // jump AFTER the scheduled time
      await swap.settle(sid, 0);
      const [L] = await swap.getParties(sid);
      expect(L.collateral).to.equal(E(4)); // priced at 1.10, not 2.00
    });
    it("a wrong round hint is rejected", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "1.10");
      await time.increase(100);
      await setPrice("2.00");
      const latest = await feed.latestRound();
      await expect(swap.settle(sid, latest)).to.be.revertedWith("Round after settlement time");
      await expect(swap.settle(sid, latest - 2n)).to.be.revertedWith("Not the round live at settlement time");
      const good = await swap.findRoundAt(0, await swap.scheduledTime(sid, 1));
      await expect(swap.settle(sid, good)).to.emit(swap, "Settled");
    });
    it("stale oracle at settlement time reverts", async function () {
      const Swap = await ethers.getContractFactory("CommSwap");
      const s2 = await Swap.deploy(FEE, GRACE, MIN_PERIOD, SELECT_WINDOW);
      await s2.addCommodity("GOLD", await feed.getAddress(), 100); // 100s heartbeat
      await s2.connect(alice).register({ value: FEE });
      await s2.connect(bob).register({ value: FEE });
      await setPrice("1.00");
      await s2.connect(alice).createRequest(0, QTY, true, PERIOD, 2, 50, { value: COLL });
      await s2.connect(bob).acceptRequest(0, { value: COLL });
      await s2.connect(alice).selectCounterparty(0, bob.address);
      await time.increase(PERIOD + 1);
      await expect(s2.settle(0, 0)).to.be.revertedWith("Stale oracle price");
    });
  });

  describe("Module 2: collateral top-up, grace period and defaults", function () {
    it("loser gets a margin call; topping up within grace restores it, no penalty", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "1.10");
      await expect(swap.settle(sid, 0)).to.emit(swap, "MarginCall");
      await swap.connect(bob).topUp(sid, { value: E(1) });
      const [, S] = await swap.getParties(sid);
      expect(S.collateral).to.equal(COLL);
      expect(S.topUpDeadline).to.equal(0);
      expect((await swap.users(bob.address)).reputation).to.equal(6);
    });
    it("enforce does nothing while the grace period is still running", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "1.10");
      await swap.settle(sid, 0);
      await swap.connect(bob).topUp(sid, { value: E("0.5") }); // partial
      await expect(swap.enforce(sid)).to.be.revertedWith("Nothing to enforce");
    });
    it("missed top-up after grace: -2 reputation, swap continues; restoring before next round avoids termination", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "1.10");
      await swap.settle(sid, 0); // bob 5 -> 6
      await time.increase(GRACE + 1);
      await expect(swap.enforce(sid)).to.emit(swap, "MissedTopUp");
      expect((await swap.users(bob.address)).reputation).to.equal(4);
      await expect(swap.enforce(sid)).to.be.revertedWith("Nothing to enforce"); // only once
      await swap.connect(bob).topUp(sid, { value: E(1) }); // late but before next settlement
      await toRound(sid, 2, "1.00");
      await swap.settle(sid, 0);
      expect((await swap.getSwap(sid)).status).to.equal(1); // still Active
    });
    it("still under-collateralised at next settlement: settle runs, then terminate, rep = 2, collateral slashed", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "1.10");
      await swap.settle(sid, 0); // bob: 2 ETH left, required 3
      await toRound(sid, 2, "1.05"); // bob loses 0.5 more
      await expect(swap.settle(sid, 0)).to.emit(swap, "SwapTerminated");
      expect((await swap.users(bob.address)).reputation).to.equal(2);
      expect((await swap.users(bob.address)).defaults).to.equal(1);
      // alice: own 4 + 0.5 won + bob's remaining 1.5 slashed = 6
      expect(await swap.withdrawable(alice.address)).to.equal(E(6));
      expect(await swap.withdrawable(bob.address)).to.equal(0);
    });
    it("under-collateralised party that WINS the cycle gets no payment, then terminated", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "1.10");
      await swap.settle(sid, 0); // bob (short) 2 ETH
      await toRound(sid, 2, "0.90"); // bob would win 1 ETH
      await expect(swap.settle(sid, 0))
        .to.emit(swap, "Settled")
        .withArgs(sid, 2, P("0.90"), P("-0.10"), E(1), 0, bob.address);
      expect(await swap.withdrawable(alice.address)).to.equal(E(6)); // 4 own + 2 slashed
    });
    it("loss bigger than collateral -> shortfall; repaying within grace keeps the swap alive", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "1.40"); // due 4 ETH, bob has 3
      await swap.settle(sid, 0);
      let [L, S] = await swap.getParties(sid);
      expect(S.collateral).to.equal(0);
      expect(S.shortfall).to.equal(E(1));
      expect(L.collateral).to.equal(E(6));
      await swap.connect(bob).topUp(sid, { value: E(4) }); // 1 pays shortfall, 3 restores collateral
      [L, S] = await swap.getParties(sid);
      expect(S.shortfall).to.equal(0);
      expect(S.collateral).to.equal(COLL);
      expect(L.collateral).to.equal(E(7)); // shortfall credited to alice's LOCKED balance, not pushed
      expect(await swap.withdrawable(alice.address)).to.equal(0);
    });
    it("unpaid shortfall after grace = serious default: terminated, rep 2, insurance pool covers the winner", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "1.40");
      await swap.settle(sid, 0);
      const fund = await swap.insuranceFund();
      await time.increase(GRACE + 1);
      await expect(swap.connect(carol).enforce(sid)).to.emit(swap, "SwapTerminated"); // anyone can enforce
      expect((await swap.users(bob.address)).reputation).to.equal(2);
      // alice: 6 locked + min(1 ETH shortfall, fund)
      expect(await swap.withdrawable(alice.address)).to.equal(E(6) + fund);
      expect(await swap.insuranceFund()).to.equal(0);
    });
    it("final-round shortfall: swap waits for repayment then matures", async function () {
      const { sid } = await openSwap({ periods: 1 });
      await toRound(sid, 1, "1.40");
      await swap.settle(sid, 0);
      expect((await swap.getSwap(sid)).status).to.equal(1); // still Active
      await expect(swap.connect(bob).topUp(sid, { value: E(1) })).to.emit(swap, "SwapMatured");
      expect(await swap.withdrawable(alice.address)).to.equal(E(7));
      expect(await swap.withdrawable(bob.address)).to.equal(0);
    });
    it("only swap participants can top up", async function () {
      const { sid } = await openSwap();
      await expect(swap.connect(carol).topUp(sid, { value: E(1) })).to.be.revertedWith("Not a participant");
    });
  });

  describe("Sybil economics", function () {
    it("a defaulter who re-registers with a new wallet starts at 5, below honest veterans, and pays the fee again", async function () {
      const { sid } = await openSwap();
      await toRound(sid, 1, "1.40");
      await swap.settle(sid, 0);
      await time.increase(GRACE + 1);
      await swap.enforce(sid);
      expect((await swap.users(bob.address)).reputation).to.equal(2);
      await swap.connect(mallory).register({ value: FEE });
      expect((await swap.users(mallory.address)).reputation).to.equal(5);
      expect((await swap.users(alice.address)).reputation).to.equal(6);
    });
  });

  describe("Gas report (for the paper's gas table)", function () {
    it("prints gas per function", async function () {
      const g = {};
      const rec = async (name, txp) => {
        const r = await (await txp).wait();
        g[name] = Number(r.gasUsed);
      };
      const Swap = await ethers.getContractFactory("CommSwap");
      const d = await Swap.deploy(FEE, GRACE, MIN_PERIOD, SELECT_WINDOW);
      g["deploy CommSwap"] = Number((await d.deploymentTransaction().wait()).gasUsed);
      await rec("addCommodity", d.addCommodity("GOLD", await feed.getAddress(), 86400));
      await rec("register", d.connect(alice).register({ value: FEE }));
      await d.connect(bob).register({ value: FEE });
      await d.connect(carol).register({ value: FEE });
      await rec("createRequest", d.connect(alice).createRequest(0, QTY, true, PERIOD, 3, 600, { value: COLL }));
      await rec("acceptRequest", d.connect(bob).acceptRequest(0, { value: COLL }));
      await d.connect(carol).acceptRequest(0, { value: COLL });
      await rec("selectCounterparty", d.connect(alice).selectCounterparty(0, bob.address));
      await rec("withdrawAcceptance", d.connect(carol).withdrawAcceptance(0));
      const t = await d.scheduledTime(0, 1);
      await time.increaseTo(t - 5n);
      await rec("oracle updateAnswer", feed.updateAnswer(P("1.10")));
      await time.increaseTo(t + 1n);
      await rec("settle (hint=0, search)", d.settle(0, 0));
      await rec("topUp", d.connect(bob).topUp(0, { value: E(1) }));
      await rec("withdraw", d.connect(carol).withdraw());
      console.table(g);
    });
  });
});
