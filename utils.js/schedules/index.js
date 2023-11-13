import schedule from "node-schedule";
import { returnMoment } from "../function.js";

const scheduleIndex = () => {
  schedule.scheduleJob("0 0/1 * * * *", async function () {
    let return_moment = returnMoment();
    if (return_moment.includes("00:00:")) {
    }
  });
};

export default scheduleIndex;
