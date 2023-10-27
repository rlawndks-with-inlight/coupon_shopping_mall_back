export const uploadMultipleFiles = async (req, res) => {
    try {
        
        console.log(req.files)
        let files = settingFiles(req.files);
      
    } catch (err) {
        console.log(err)
        return response(req, res, -200, "서버 에러 발생", false)
    } finally {

    }
}