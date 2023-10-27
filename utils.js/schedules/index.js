import schedule from 'node-schedule';

const scheduleIndex = () => {
    schedule.scheduleJob('0 0/1 * * * *', async function () {

    })
}

export default scheduleIndex;