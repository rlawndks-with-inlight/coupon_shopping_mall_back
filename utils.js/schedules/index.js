import schedule from "node-schedule";
import { returnMoment } from "../function.js";
import { langProcess } from "./lang-process.js";

const scheduleIndex = () => {
  schedule.scheduleJob("0 0/1 * * * *", async function () {
    let return_moment = returnMoment();

    langProcess();
  });
};

export default scheduleIndex;
