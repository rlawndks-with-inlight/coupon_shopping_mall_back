import schedule from "node-schedule";
import { returnMoment } from "../function.js";
import { langProcess } from "./lang-process.js";
import { setGrandParisProducts } from "../../controllers/util.controller.js";
import { getArfighterItems } from '../corps/arfighter.js'

const scheduleIndex = () => {
  schedule.scheduleJob("0 0/1 * * * *", async function () {
    if (parseInt(process.env.INSTANCE_ID) != parseInt(process.env.instances) - 1) {
      return;
    }
    let return_moment = returnMoment();
    langProcess();
    if (return_moment.includes('00:00:')) {
      getArfighterItems();
    }
    if (return_moment.includes('00:00:')) {
      // setGrandParisProducts();
    }
  });
};

export default scheduleIndex;
