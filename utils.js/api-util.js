import logger from "./winston/index.js";
export const uploadMultipleFiles = async (req, res) => {
    try {
        
        console.log(req.files)
        let files = settingFiles(req.files);
      
    } catch (err) {
        console.log(err)
        logger.error(JSON.stringify(err?.response?.data || err))
        return response(req, res, -200, "서버 에러 발생", false)
    } finally {

    }
}